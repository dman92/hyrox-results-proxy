/**
 * Descarga las listas de finishers de results.hyrox.com a JSONL local.
 *
 * Solo listas (nombre, puesto, tiempo, idp, grupo de edad): 100 personas por
 * petición. Los splits NO se tocan — esos son una petición por atleta y no
 * compensan; siguen resolviéndose bajo demanda en /api/athlete.
 *
 *   node --experimental-strip-types scripts/ingest.ts --season 9
 *   node --experimental-strip-types scripts/ingest.ts --season 8 --season 9
 *   node --experimental-strip-types scripts/ingest.ts --season 8 --max-events 5
 *
 * Reanudable: relanzarlo salta los eventos ya volcados según el checkpoint.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as cheerio from 'cheerio';
import { parseListRows, USER_AGENT } from '../lib/hyrox.ts';

const BASE = 'https://results.hyrox.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 300;            // 30.000 finishers por evento-división
const OUT_DIR = 'data';

interface Args { seasons: string[]; rate: number; maxEvents: number | null; outDir: string }

function parseArgs(argv: string[]): Args {
  const seasons: string[] = [];
  let rate = 2, maxEvents: number | null = null, outDir = OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    if (argv[i] === '--season') seasons.push(`season-${next().replace(/^season-/, '')}`);
    else if (argv[i] === '--rate') rate = Number(next());
    else if (argv[i] === '--max-events') maxEvents = Number(next());
    else if (argv[i] === '--out') outDir = next();
  }
  if (seasons.length === 0) throw new Error('Falta --season <n> (repetible)');
  return { seasons, rate, maxEvents, outDir };
}

let requestCount = 0;
async function get(url: string, minIntervalMs: number): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(45_000),
      });
      requestCount++;
      if (res.ok) {
        const body = await res.text();
        // El ritmo se cuenta desde el inicio: una petición lenta ya "esperó".
        await sleep(Math.max(0, minIntervalMs - (Date.now() - started)));
        return body;
      }
      if (![502, 503, 504, 429].includes(res.status)) {
        throw new Error(`HTTP ${res.status} en ${url}`);
      }
    } catch (err) {
      if (attempt === 3) throw err;
    }
    // Su origen va lento o nos está frenando: aflojamos antes de reintentar.
    await sleep(2_000 * attempt);
  }
  throw new Error(`sin respuesta tras 3 intentos: ${url}`);
}

/** Los códigos de evento salen del selector: los prefijos de división no son
 *  deducibles (HD, HD1, HA, HDP, HMR, HE, HY3, THD, WCHE...). */
async function listEvents(season: string, rate: number): Promise<{ code: string; label: string }[]> {
  const html = await get(`${BASE}/${season}/?pid=list`, 1000 / rate);
  const $ = cheerio.load(html);
  const events: { code: string; label: string }[] = [];
  $('select[name="event"] option').each((_, el) => {
    const code = ($(el).attr('value') ?? '').trim();
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (code) events.push({ code, label });
  });
  return events;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const minInterval = 1000 / args.rate;
  mkdirSync(args.outDir, { recursive: true });
  const startedAt = Date.now();
  let totalRows = 0;

  for (const season of args.seasons) {
    const outFile = `${args.outDir}/${season}.jsonl`;
    const stateFile = `${args.outDir}/${season}.progress.json`;
    const done: Record<string, number> = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf8'))
      : {};

    let events = await listEvents(season, args.rate);
    if (args.maxEvents) events = events.slice(0, args.maxEvents);
    const pending = events.filter((e) => !(e.code in done));
    console.log(`\n${season}: ${events.length} eventos-división (${pending.length} pendientes)`);

    for (const [i, event] of pending.entries()) {
      let rows = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${BASE}/${season}/?pid=list&event=${event.code}&num_results=${PAGE_SIZE}&page=${page}`;
        const parsed = parseListRows(await get(url, minInterval));
        if (parsed.length === 0) break;

        const lines = parsed.map((row) => JSON.stringify({
          season, eventCode: event.code, eventLabel: event.label, ...row,
        }));
        appendFileSync(outFile, lines.join('\n') + '\n');
        rows += parsed.length;
        if (parsed.length < PAGE_SIZE) break;
      }

      done[event.code] = rows;
      totalRows += rows;
      writeFileSync(stateFile, JSON.stringify(done, null, 0));

      const elapsed = (Date.now() - startedAt) / 1000;
      const pct = (((i + 1) / pending.length) * 100).toFixed(1);
      const eta = ((elapsed / (i + 1)) * (pending.length - i - 1) / 60).toFixed(0);
      process.stdout.write(
        `\r  [${pct}%] ${i + 1}/${pending.length} ${event.code.padEnd(22)} ` +
        `${totalRows.toLocaleString()} filas · ${requestCount} peticiones · ETA ${eta} min   `,
      );
    }
    console.log(`\n  ${season} -> ${outFile}`);
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nHecho: ${totalRows.toLocaleString()} filas en ${requestCount} peticiones (${mins} min)`);
}

main().catch((err) => { console.error('\nERROR:', err.message); process.exit(1); });
