/**
 * Descarga las listas de finishers de results.hyrox.com.
 *
 * Solo listas (nombre, puesto, tiempo, idp, grupo de edad): 100 personas por
 * petición. Los splits NO se tocan — esos son una petición por atleta y no
 * compensan; siguen resolviéndose bajo demanda en /api/athlete (y se cachean).
 *
 * Destino:
 *   - Con DATABASE_URL: a Postgres/Neon (tablas de lib/db.ts). Es lo que usa la API.
 *   - Sin DATABASE_URL: a data/<season>.jsonl, como antes.
 *
 *   node --experimental-strip-types scripts/ingest.ts --season 9
 *   node --experimental-strip-types scripts/ingest.ts --season 7 --season 8 --season 9 --max-minutes 300
 *   node --experimental-strip-types scripts/ingest.ts --season 8 --max-events 5
 *
 * Reanudable: relanzarlo salta los eventos ya volcados (checkpoint en la base de
 * datos o en data/<season>.progress.json). --max-minutes para con elegancia antes
 * de empezar un evento nuevo si ya no queda tiempo: GitHub Actions corta a las 6h.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import { parseListRows, splitEventCode, USER_AGENT, type ListRow } from '../lib/hyrox.ts';
import { getDb, migrate, pendingEventCodes, saveEventRows, upsertEvents, type Query } from '../lib/db.ts';

const BASE = 'https://results.hyrox.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 300;            // 30.000 finishers por evento-división
const OUT_DIR = 'data';
const MAX_CONSECUTIVE_FAILURES = 5;

export interface Args {
  seasons: string[]; rate: number; maxEvents: number | null; outDir: string;
  maxMinutes: number | null; refreshDays: number;
}

export function parseArgs(argv: string[]): Args {
  const seasons: string[] = [];
  let rate = 2, maxEvents: number | null = null, outDir = OUT_DIR, maxMinutes: number | null = null, refreshDays = 10;
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    if (argv[i] === '--season') seasons.push(`season-${next().replace(/^season-/, '')}`);
    else if (argv[i] === '--rate') rate = Number(next());
    else if (argv[i] === '--max-events') maxEvents = Number(next());
    else if (argv[i] === '--out') outDir = next();
    else if (argv[i] === '--max-minutes') maxMinutes = Number(next());
    else if (argv[i] === '--refresh-days') refreshDays = Number(next());
  }
  if (seasons.length === 0) throw new Error('Falta --season <n> (repetible)');
  return { seasons, rate, maxEvents, outDir, maxMinutes, refreshDays };
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
    // Los *_OVERALL son rankings agregados por sede, no resultados fuente:
    // repiten a los mismos atletas con otro idp y su paginacion da la vuelta
    // en lugar de acabar (30.000 filas = 7.500 registros x4). Fuera.
    if (code && !code.endsWith('_OVERALL')) events.push({ code, label });
  });
  return events;
}

/** Descarga todas las páginas de un evento. Devuelve cada idp una sola vez. */
async function fetchEventRows(season: string, code: string, minInterval: number): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}/${season}/?pid=list&event=${code}&num_results=${PAGE_SIZE}&page=${page}`;
    const parsed = parseListRows(await get(url, minInterval));
    if (parsed.length === 0) break;

    // Hay eventos cuyo listado repite cada fila varias veces en el propio
    // HTML (100 filas para 30 idps). Nos quedamos con la primera de cada.
    // Marcar dentro del mismo filter: si no, dos copias del mismo idp en
    // una misma pagina pasan las dos (se comparan contra un seen sin tocar).
    const fresh = parsed.filter((row) => {
      if (seen.has(row.idp)) return false;
      seen.add(row.idp);
      return true;
    });

    // Y si una pagina entera no aporta nadie nuevo, el listado esta
    // ciclando: cortamos en vez de gastar hasta MAX_PAGES.
    if (fresh.length === 0) break;
    rows.push(...fresh);
    if (parsed.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Dónde se guarda cada evento y cómo se sabe qué falta. */
export interface Sink {
  describe(season: string): string;
  pending(season: string, events: { code: string; label: string }[]): Promise<{ code: string; label: string }[]>;
  save(season: string, event: { code: string; label: string }, rows: ListRow[]): Promise<void>;
}

export function dbSink(db: Query, refreshDays: number): Sink {
  return {
    describe: () => 'Postgres (DATABASE_URL)',
    async pending(season, events) {
      await upsertEvents(db, season, events.map((e) => ({ ...e, division: splitEventCode(e.code).division })));
      const codes = await pendingEventCodes(db, season, refreshDays);
      return events.filter((e) => codes.has(e.code));
    },
    // Todo el evento de una vez al final: si se cancela a mitad no queda a medias,
    // y el upsert hace que repetirlo no duplique nada.
    save: (season, event, rows) => saveEventRows(db, season, event.code, rows),
  };
}

function fileSink(outDir: string): Sink {
  mkdirSync(outDir, { recursive: true });
  const state = (season: string) => `${outDir}/${season}.progress.json`;
  const load = (season: string): Record<string, number> =>
    existsSync(state(season)) ? JSON.parse(readFileSync(state(season), 'utf8')) : {};
  return {
    describe: (season) => `${outDir}/${season}.jsonl`,
    pending: async (season, events) => {
      const done = load(season);
      return events.filter((e) => !(e.code in done));
    },
    // El checkpoint solo se guarda cuando el evento esta completo.
    async save(season, event, rows) {
      const lines = rows.map((row) => JSON.stringify({ season, eventCode: event.code, eventLabel: event.label, ...row }));
      if (lines.length > 0) appendFileSync(`${outDir}/${season}.jsonl`, lines.join('\n') + '\n');
      const done = load(season);
      done[event.code] = rows.length;
      writeFileSync(state(season), JSON.stringify(done, null, 0));
    },
  };
}

export async function run(args: Args, injectedDb?: Query | null): Promise<{ rows: number; failures: number }> {
  const minInterval = 1000 / args.rate;
  const startedAt = Date.now();
  const deadline = args.maxMinutes ? startedAt + args.maxMinutes * 60_000 : Infinity;
  let totalRows = 0;
  let failures = 0;
  let consecutiveFailures = 0;

  const db = injectedDb === undefined ? getDb() : injectedDb;
  if (db) await migrate(db);
  const sink = db ? dbSink(db, args.refreshDays) : fileSink(args.outDir);

  for (const season of args.seasons) {
    let events = await listEvents(season, args.rate);
    if (args.maxEvents) events = events.slice(0, args.maxEvents);
    const pending = await sink.pending(season, events);
    console.log(`\n${season}: ${events.length} eventos-división (${pending.length} pendientes) -> ${sink.describe(season)}`);

    for (const [i, event] of pending.entries()) {
      if (Date.now() > deadline) {
        console.log(`\nTiempo agotado (--max-minutes ${args.maxMinutes}): la próxima ejecución sigue desde aquí.`);
        return summary();
      }
      let rows: ListRow[];
      try {
        rows = await fetchEventRows(season, event.code, minInterval);
        await sink.save(season, event, rows);
        consecutiveFailures = 0;
      } catch (err) {
        // Un evento roto no debe bloquear el resto: queda pendiente para la próxima.
        // Muchos seguidos ya no es un evento roto: probablemente nos están bloqueando.
        failures++;
        console.error(`\n  ${event.code}: ${(err as Error).message}`);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`${consecutiveFailures} eventos seguidos fallaron; paro. Último: ${(err as Error).message}`);
        }
        continue;
      }
      totalRows += rows.length;

      const elapsed = (Date.now() - startedAt) / 1000;
      const pct = (((i + 1) / pending.length) * 100).toFixed(1);
      const eta = ((elapsed / (i + 1)) * (pending.length - i - 1) / 60).toFixed(0);
      // En CI no hay terminal: una línea por evento en vez de reescribir la misma.
      const line =
        `  [${pct}%] ${i + 1}/${pending.length} ${event.code.padEnd(22)} ` +
        `${totalRows.toLocaleString()} filas · ${requestCount} peticiones · ETA ${eta} min`;
      if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
      else console.log(line);
    }
    console.log(`\n  ${season} listo`);
  }
  return summary();

  function summary() {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(
      `\nHecho: ${totalRows.toLocaleString()} filas en ${requestCount} peticiones (${mins} min)` +
      (failures ? `, ${failures} eventos fallidos (se reintentan en la próxima ejecución)` : ''),
    );
    return { rows: totalRows, failures };
  }
}

// Solo al ejecutarlo directamente; los tests lo importan.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs(process.argv.slice(2))).catch((err) => { console.error('\nERROR:', err.message); process.exit(1); });
}
