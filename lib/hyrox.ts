import * as cheerio from 'cheerio';

const BASE = 'https://results.hyrox.com';
const DEFAULT_SEASON = 'season-9';

// OJO: results.hyrox.com devuelve 403 a cualquier User-Agent que no parezca un
// navegador (probado: UA propio -> 403, vacío -> 403, "...Bot..." -> 403).
// Es decir, el sitio filtra clientes automatizados de forma deliberada.
// Tenlo en cuenta al decidir si este proxy es la vía definitiva o solo el plan A:
// lib/hyrox.ts es intercambiable por una implementación contra una API de pago.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const DIVISIONS = {
  open: 'H',
  pro: 'HPRO',
  doubles: 'HD',
  pro_doubles: 'HDP',
  relay: 'HMR',
} as const;

export type Division = keyof typeof DIVISIONS;

export interface RaceHit {
  idp: string;
  division: Division;
  /**
   * Evento del que salió el idp, o null si vino del ranking all-time. Hay que
   * devolverlo tal cual a /api/athlete: un idp de lista por evento no resuelve
   * contra la URL de detalle del all-time, y viceversa.
   */
  eventId: string | null;
  /**
   * Temporada de la URL de la que salió el idp. Solo importa en búsquedas por
   * evento: el detalle de una carrera de season-8 consultado bajo season-9
   * devuelve 200 con la ficha vacía, no un error. Hay que devolverla igual que
   * el eventId. null = ranking all-time, que resuelve bajo la temporada actual.
   */
  season: string | null;
  rank: number | null;
  name: string;
  nationality: string | null;
  city: string | null;
  year: number | null;
  ageGroup: string | null;
  totalTime: string | null;
  totalSec: number | null;
}

export interface Split {
  key: string;
  label: string;
  time: string;
  seconds: number;
  place: number | null;
}

export interface RaceDetail {
  idp: string;
  division: Division;
  divisionLabel: string | null;
  name: string | null;
  /** Dobles/relevos: un miembro por entrada. Vacío en individual. */
  members: { name: string; nationality: string | null }[];
  nationality: string | null;
  ageGroup: string | null;
  bib: string | null;
  city: string | null;
  year: number | null;
  bonus: string | null;
  penalty: string | null;
  disqualReason: string | null;
  rankGender: number | null;
  rankAgeGroup: number | null;
  splits: Split[];
  /** Comprobaciones de integridad: si fallan, el HTML de origen cambió. */
  validation: { runSumMatchesRunTotal: boolean | null; splitCount: number; ok: boolean };
}

/** "00:59:17" | "59:17" -> segundos */
export function hmsToSec(t: string): number | null {
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, mm, ss] = m;
  return (parseInt(h ?? '0', 10) * 3600) + (parseInt(mm, 10) * 60) + parseInt(ss, 10);
}

/** Etiqueta de mika -> clave estable, insensible a que cambien las distancias. */
export function canonicalKey(label: string): string {
  const l = label.toLowerCase();
  const run = l.match(/^running\s*(\d+)/);
  if (run) return `run_${run[1]}`;
  if (l.includes('run total')) return 'run_total';
  if (l.includes('best run lap')) return 'best_run_lap';
  if (l.includes('skierg') || l.includes('ski erg')) return 'ski_erg';
  if (l.includes('sled push')) return 'sled_push';
  if (l.includes('sled pull')) return 'sled_pull';
  if (l.includes('burpee')) return 'burpee_broad_jump';
  if (l.includes('row')) return 'row_erg';
  if (l.includes('farmer')) return 'farmers_carry';
  if (l.includes('lunge')) return 'sandbag_lunges';
  if (l.includes('wall ball')) return 'wall_balls';
  if (l.includes('roxzone')) return 'roxzone';
  if (l.includes('overall time') || l === 'total') return 'total';
  return l.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** "Dearden, Jake (ENG)" -> { name, nationality }. Sin paréntesis, nacionalidad null. */
function splitNationality(v: string): { name: string; nationality: string | null } {
  const m = v.match(/^(.*?)\s*\(([A-Z]{2,3})\)\s*$/);
  return m ? { name: m[1].trim(), nationality: m[2] } : { name: v.trim(), nationality: null };
}

export class UpstreamTimeout extends Error {
  constructor() { super('results.hyrox.com no respondió a tiempo'); this.name = 'UpstreamTimeout'; }
}

// Una consulta en frío hace que results.hyrox.com tarde ~25-30s o devuelva un
// 504 suyo; en cuanto entra en su x-results-cache, responde en <1s. Por eso dos
// intentos cortos funcionan mejor que uno largo: el primero calienta su caché.
// 28s x 2 = 56s, dentro del maxDuration de 60 que fija vercel.json.
const UPSTREAM_TIMEOUT_MS = 28_000;
const UPSTREAM_ATTEMPTS = 2;

/** 502/503/504 del origen son "está ocupado", no "no existe": se reintentan. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

async function attempt(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new UpstreamTimeout();
    }
    throw err;
  }
  if (GATEWAY_STATUSES.has(res.status)) throw new UpstreamTimeout();
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return res.text();
}

async function get(url: string): Promise<string> {
  let last: unknown;
  for (let i = 0; i < UPSTREAM_ATTEMPTS; i++) {
    try {
      return await attempt(url);
    } catch (err) {
      if (!(err instanceof UpstreamTimeout)) throw err;
      last = err;
    }
  }
  throw last;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
}

/**
 * Busca por APELLIDO en el ranking all-time (cross-evento y cross-temporada).
 * Ojo: en dobles/relevos mika ignora search[name] aquí -> usar searchInEvent().
 */
/**
 * mika ignora num_results con valores arbitrarios (pedir 3 devuelve 12), así que
 * pedimos uno de los que sí respeta y recortamos al limit real en parseSearch.
 */
function pageSize(limit: number): 25 | 50 | 100 {
  if (limit <= 25) return 25;
  if (limit <= 50) return 50;
  return 100;
}

export function searchUrl(opts: {
  surname: string; division?: Division; sex?: 'M' | 'W'; ageClass?: string;
  limit?: number; season?: string;
}): string {
  const div = DIVISIONS[opts.division ?? 'open'];
  const qs = buildQuery({
    pid: 'list_overall',
    event: `${div}_HYROXOVERALL`,
    num_results: pageSize(opts.limit ?? 50),
    'search[name]': opts.surname,
    'search[sex]': opts.sex,
    'search[age_class]': opts.ageClass,
  });
  return `${BASE}/${opts.season ?? DEFAULT_SEASON}/?${qs}`;
}

/** Búsqueda dentro de un evento concreto. Único camino válido para DOBLES. */
export function searchInEventUrl(opts: {
  surname: string; eventId: string; division?: Division; limit?: number; season?: string;
}): string {
  const div = DIVISIONS[opts.division ?? 'doubles'];
  const qs = buildQuery({
    pid: 'list',
    event: `${div}_${opts.eventId}`,
    num_results: pageSize(opts.limit ?? 50),
    'search[name]': opts.surname,
  });
  return `${BASE}/${opts.season ?? DEFAULT_SEASON}/?${qs}`;
}

export function detailUrl(
  idp: string,
  division: Division = 'open',
  eventId: string | null = null,
  season = DEFAULT_SEASON,
): string {
  const pid = eventId ? 'list' : 'list_overall';
  const event = eventId ? `${DIVISIONS[division]}_${eventId}` : `${DIVISIONS[division]}_HYROXOVERALL`;
  const qs = buildQuery({ content: 'detail', pid, idp, lang: 'EN_CAP', event });
  return `${BASE}/${season}/?${qs}`;
}

/** Una fila de listado, sin el contexto (división/evento/temporada) que la envuelve. */
export type ListRow = Omit<RaceHit, 'division' | 'eventId' | 'season'>;

/**
 * Filas de cualquier listado de mika: ranking all-time o lista por evento.
 * Separado de parseSearch para que la ingesta pueda recorrer eventos cuyo
 * prefijo de división no está en DIVISIONS (HD1, HA, HY3, THD, WCHE...).
 */
export function parseListRows(html: string): ListRow[] {
  const $ = cheerio.load(html);
  const rows: ListRow[] = [];

  $('li.list-group-item.row').each((_, el) => {
    const $row = $(el);
    // Las etiquetas móviles duplican el texto de cada campo: fuera antes de leer.
    $row.find('.list-label').remove();

    // Individual usa type-fullname; dobles y relevos, type-relay_member.
    const $a = $row.find('h4.type-fullname a, h4.type-relay_member a').first();
    const href = $a.attr('href');
    if (!href) return; // fila de cabecera, no un atleta

    const idp = new URLSearchParams(href.replace(/^\?/, '').replace(/&amp;/g, '&')).get('idp');
    if (!idp) return;

    // Igual que en el detalle, el nombre puede venir como "Apellido, Nombre (USA)".
    const fullname = splitNationality($a.text().trim());
    const cityYear = $row.find('.type-field').first().text().trim();
    const yearMatch = cityYear.match(/\b(20\d{2})\b/);
    const totalTime = $row.find('.type-time').first().text().trim() || null;
    const rankText = $row.find('.type-place.place-primary').first().text().trim();

    rows.push({
      idp,
      rank: /^\d+$/.test(rankText) ? parseInt(rankText, 10) : null,
      name: fullname.name,
      nationality:
        $row.find('.type-nation_flag .nation__abbr').text().trim() ||
        $row.find('.type-nation_flag img').attr('alt') ||
        fullname.nationality || null,
      city: yearMatch ? cityYear.replace(yearMatch[0], '').trim() : cityYear || null,
      year: yearMatch ? parseInt(yearMatch[1], 10) : null,
      ageGroup: $row.find('.type-age_class').first().text().trim() || null,
      totalTime,
      totalSec: totalTime ? hmsToSec(totalTime) : null,
    });
  });

  return rows;
}

export function parseSearch(
  html: string,
  division: Division,
  eventId: string | null = null,
  season: string | null = null,
): RaceHit[] {
  return parseListRows(html).map((row) => ({ ...row, division, eventId, season }));
}

export function parseDetail(html: string, idp: string, division: Division): RaceDetail {
  const $ = cheerio.load(html);

  // Cabecera: pares th|td repartidos por varias tablas.
  const info: Record<string, string> = {};
  const splits: Split[] = [];

  $('table').each((_, table) => {
    const $table = $(table);
    // La página de detalle por evento añade una tabla de paso por la roxzone
    // con horas de reloj ("Rox In | 08:04:15"). No son duraciones ni splits.
    if (/time of day/i.test($table.find('tr').first().text())) return;

    $table.find('tr').each((__, tr) => {
    const cells = $(tr).find('th, td').map((___, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length === 2 && cells[0] && cells[1]) {
      info[cells[0]] = cells[1];
      return;
    }
    // Splits: etiqueta | tiempo | puesto
    if (cells.length >= 2) {
      const [label, time, place] = cells;
      if (label && /^\d{1,2}:\d{2}:\d{2}$/.test(time ?? '')) {
        const seconds = hmsToSec(time);
        if (seconds === null) return;
        splits.push({
          key: canonicalKey(label),
          label,
          time,
          seconds,
          place: place && /^\d+$/.test(place) ? parseInt(place, 10) : null,
        });
      }
    }
    });
  });

  const members: { name: string; nationality: string | null }[] = [];
  for (const [k, v] of Object.entries(info)) {
    if (!/^Member \d+$/.test(k)) continue;
    members.push(splitNationality(v));
  }

  // Las páginas de detalle no usan siempre la misma etiqueta: unas traen
  // "Name" + "Nat" por separado y otras un "Athlete" con la nacionalidad dentro.
  const athleteRaw = info['Name'] ?? info['Athlete'] ?? info['Member'] ?? null;
  const athlete = athleteRaw
    ? splitNationality(athleteRaw)
    : members.length > 0
      // Por evento, el equipo no tiene fila propia: se compone con sus miembros.
      // Con " / " y no ", ", porque cada nombre ya lleva su propia coma.
      ? { name: members.map((m) => m.name).join(' / '), nationality: null }
      : null;

  const num = (k: string): number | null => {
    const v = info[k];
    return v && /^\d+$/.test(v) ? parseInt(v, 10) : null;
  };

  // All-time lo llama "City" ("Bangkok 2026"); por evento, "Race" ("2026 Bangkok").
  // En all-time "Race" vale "General Ranking", así que solo sirve si lleva año.
  const raceField = info['Race'] ?? '';
  const cityYear = info['City'] ?? (/\b20\d{2}\b/.test(raceField) ? raceField : '');
  const yearMatch = cityYear.match(/\b(20\d{2})\b/);

  // Por evento el total no está en la tabla de splits, sino como "Overall Time".
  if (!splits.some((sp) => sp.key === 'total') && info['Overall Time']) {
    const seconds = hmsToSec(info['Overall Time']);
    if (seconds !== null) {
      splits.push({ key: 'total', label: 'Overall Time', time: info['Overall Time'], seconds, place: null });
    }
  }

  const runSum = splits
    .filter((s) => /^run_\d+$/.test(s.key))
    .reduce((acc, s) => acc + s.seconds, 0);
  const runTotal = splits.find((s) => s.key === 'run_total')?.seconds ?? null;

  // mika redondea cada split al segundo: 8 runs acumulan hasta ~8s de deriva
  // frente a Run Total. Más de 10s ya no es redondeo, es que cambió el HTML.
  const RUN_SUM_TOLERANCE_SEC = 10;
  const runSumMatchesRunTotal =
    runTotal === null || runSum === 0
      ? null
      : Math.abs(runSum - runTotal) <= RUN_SUM_TOLERANCE_SEC;

  return {
    idp,
    division,
    divisionLabel: info['Division'] ?? null,
    name: athlete?.name ?? null,
    members,
    nationality: info['Nat'] ?? athlete?.nationality ?? null,
    ageGroup: info['Age Group'] ?? null,
    bib: info['Bib Number'] && info['Bib Number'] !== '–' ? info['Bib Number'] : null,
    city: yearMatch ? cityYear.replace(yearMatch[0], '').trim() : cityYear || null,
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    bonus: info['*Bonus'] && info['*Bonus'] !== '–' ? info['*Bonus'] : null,
    penalty: info['*Penalty'] && info['*Penalty'] !== '–' ? info['*Penalty'] : null,
    disqualReason: info['Disqual Reason'] && info['Disqual Reason'] !== '–' ? info['Disqual Reason'] : null,
    rankGender: num('Rank (M/W)'),
    rankAgeGroup: num('Rank (AG)'),
    splits,
    validation: {
      runSumMatchesRunTotal,
      splitCount: splits.length,
      // 8 runs + 8 estaciones + roxzone + total = 18 mínimo razonable
      ok: splits.length >= 18 && runSumMatchesRunTotal !== false && athlete !== null,
    },
  };
}

export async function search(opts: Parameters<typeof searchUrl>[0]): Promise<RaceHit[]> {
  const division = opts.division ?? 'open';
  const hits = parseSearch(await get(searchUrl(opts)), division);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

export async function searchInEvent(opts: Parameters<typeof searchInEventUrl>[0]): Promise<RaceHit[]> {
  const division = opts.division ?? 'doubles';
  const season = opts.season ?? DEFAULT_SEASON;
  const hits = parseSearch(await get(searchInEventUrl(opts)), division, opts.eventId, season);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

export async function detail(
  idp: string,
  division: Division = 'open',
  eventId: string | null = null,
  season: string = DEFAULT_SEASON,
): Promise<RaceDetail> {
  return parseDetail(await get(detailUrl(idp, division, eventId, season)), idp, division);
}
