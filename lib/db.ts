import { neon } from '@neondatabase/serverless';
import type { Division, ListRow } from './hyrox.ts';

/**
 * Base de datos opcional (Neon/Postgres). Si no hay DATABASE_URL, el proxy funciona
 * como siempre, en vivo contra results.hyrox.com.
 *
 * - results: filas de los listados por evento, volcadas por scripts/ingest.ts.
 *   Es lo que hace que /api/search responda al instante en vez de esperar ~30s.
 * - details: caché de /api/athlete. Un resultado pasado no cambia, así que la
 *   primera consulta en vivo se guarda y las siguientes no tocan results.hyrox.com.
 */

export type Query = (text: string, params?: unknown[]) => Promise<Record<string, any>[]>;

let cached: Query | null | undefined;

export function getDb(): Query | null {
  if (cached === undefined) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      cached = null;
    } else {
      const sql = neon(url);
      cached = (text, params = []) => sql.query(text, params) as Promise<Record<string, any>[]>;
    }
  }
  return cached;
}

// Una sentencia por elemento: el driver HTTP de Neon no admite varias por consulta.
export const SCHEMA: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE TABLE IF NOT EXISTS events (
     code          text PRIMARY KEY,
     season        text NOT NULL,          -- 'season-8', mismo formato que la API
     label         text NOT NULL,
     division      text,                   -- clave de DIVISIONS, o null si el prefijo no es conocido
     row_count     integer,
     completed_at  timestamptz,            -- checkpoint: evento volcado entero
     first_seen_at timestamptz NOT NULL DEFAULT now(),
     -- true si apareció cuando la temporada ya estaba volcada: es una carrera
     -- nueva y se vuelve a descargar unos días por si publican correcciones.
     -- Los eventos de la carga inicial son carreras pasadas y no se refrescan.
     refresh       boolean NOT NULL DEFAULT false
   )`,
  `CREATE TABLE IF NOT EXISTS results (
     event_code  text NOT NULL,
     idp         text NOT NULL,
     season      text NOT NULL,
     name        text NOT NULL,
     name_norm   text NOT NULL,
     nationality text,
     age_group   text,
     city        text,
     year        smallint,
     rank        integer,
     total_sec   integer,
     PRIMARY KEY (event_code, idp)
   )`,
  // Mismo texto que usa searchQuery(), para que Postgres use el índice trigram
  `CREATE INDEX IF NOT EXISTS results_name_trgm ON results USING gin ((' ' || name_norm) gin_trgm_ops)`,
  // Versiones anteriores marcaban como completos los eventos sin filas: se reabren.
  `UPDATE events SET completed_at = NULL WHERE row_count = 0 AND completed_at IS NOT NULL`,
  // Versiones anteriores dejaban pasar rankings agregados con sufijo (HDP_PARIS25_OVERALL_2),
  // que repiten a los mismos atletas con otro idp. Se borran.
  `DELETE FROM results WHERE event_code IN (SELECT code FROM events WHERE strpos(code, '_OVERALL') > 0)`,
  `DELETE FROM events WHERE strpos(code, '_OVERALL') > 0`,
  // Orden del desplegable de la web (sirve para ordenar carreras, que no traen fecha)
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS position integer`,
  // Sede: el <optgroup> del desplegable de la web ("2026 Stockholm")
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS place text`,
  // Versiones anteriores marcaban con '' las carreras cuya ficha no traía sede
  `UPDATE events SET place = NULL WHERE place = ''`,
  // Última vez que se miró un evento. Las carreras futuras salen en el desplegable
  // sin resultados: se miran como mucho una vez al día, no en cada ejecución.
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS checked_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS details (
     cache_key  text PRIMARY KEY,            -- la URL de detalle de results.hyrox.com
     data       jsonb NOT NULL,
     fetched_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export async function migrate(db: Query): Promise<void> {
  for (const statement of SCHEMA) await db(statement);
}

let schemaReady: Promise<void> | null = null;

/**
 * Para la API: aplica el esquema una vez por instancia antes de usar columnas
 * nuevas, sin esperar a que arranque la siguiente ingesta. Es idempotente.
 */
export function ensureSchema(db: Query): Promise<void> {
  schemaReady ??= migrate(db).catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}

// --------------------------------------------------------------------------- nombres

/** "Pérez García, Ana" -> ['perez', 'garcia', 'ana'] */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Forma canónica independiente del orden: "Pérez, Ana" y "Ana Perez" -> "ana perez". */
export function normalizeName(name: string): string {
  return nameTokens(name).sort().join(' ');
}

// --------------------------------------------------------------------------- ingesta

export interface EventRow {
  code: string;
  label: string;
  division: Division | null;
  /** Sede: el <optgroup> del desplegable de la web ("2026 Stockholm"). */
  place: string | null;
}

export async function upsertEvents(db: Query, season: string, events: EventRow[]): Promise<void> {
  if (events.length === 0) return;
  const known = (await db(`SELECT 1 FROM events WHERE season = $1 LIMIT 1`, [season])).length > 0;
  await db(
    `INSERT INTO events (code, season, label, division, position, place, refresh)
     SELECT c, s, l, d, p, pl, $7::boolean
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[], $6::text[]) AS t(c, s, l, d, p, pl)
     ON CONFLICT (code) DO UPDATE SET
       label = EXCLUDED.label, division = EXCLUDED.division, position = EXCLUDED.position,
       place = coalesce(EXCLUDED.place, events.place)`,
    [
      events.map((e) => e.code), events.map(() => season), events.map((e) => e.label),
      events.map((e) => e.division), events.map((_, i) => i), events.map((e) => e.place), known,
    ],
  );
}

/**
 * Eventos que hay que (re)descargar: los que nunca se completaron y, durante
 * `refreshDays` días, las carreras nuevas (como mucho cada 12h), porque justo
 * después de una carrera la web todavía publica y corrige resultados.
 */
export async function pendingEventCodes(db: Query, season: string, refreshDays: number): Promise<Set<string>> {
  const rows = await db(
    `SELECT code FROM events
     WHERE season = $1 AND (
       (completed_at IS NULL AND (checked_at IS NULL OR checked_at < now() - interval '20 hours'))
       OR (refresh AND first_seen_at > now() - make_interval(days => $2)
           AND completed_at < now() - interval '12 hours'))`,
    [season, refreshDays],
  );
  return new Set(rows.map((r) => r.code as string));
}

const BATCH = 2000;

/**
 * Guarda todas las filas de un evento y lo marca como completo. Idempotente.
 * Un evento sin filas (carrera que aún no se ha celebrado) no se marca: sigue
 * pendiente y se vuelve a mirar pasadas 20 h (1 petición).
 */
export async function saveEventRows(db: Query, season: string, eventCode: string, rows: ListRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    await db(
      `INSERT INTO results (event_code, idp, season, name, name_norm, nationality, age_group, city, year, rank, total_sec)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                                $8::text[], $9::smallint[], $10::integer[], $11::integer[])
       ON CONFLICT (event_code, idp) DO UPDATE SET
         name = EXCLUDED.name, name_norm = EXCLUDED.name_norm, nationality = EXCLUDED.nationality,
         age_group = EXCLUDED.age_group, city = EXCLUDED.city, year = EXCLUDED.year,
         rank = EXCLUDED.rank, total_sec = EXCLUDED.total_sec`,
      [
        eventCode,
        b.map((r) => r.idp),
        b.map(() => season),
        b.map((r) => r.name),
        b.map((r) => normalizeName(r.name)),
        b.map((r) => r.nationality),
        b.map((r) => r.ageGroup),
        b.map((r) => r.city),
        b.map((r) => r.year),
        b.map((r) => r.rank),
        b.map((r) => r.totalSec),
      ],
    );
  }
  await db(
    `UPDATE events SET completed_at = CASE WHEN $2 > 0 THEN now() END, row_count = $2, checked_at = now()
     WHERE code = $1`,
    [eventCode, rows.length],
  );
}

// --------------------------------------------------------------------------- búsqueda

export interface DbHit {
  idp: string;
  /** null si el prefijo del evento no es una división conocida: usar `event` en /api/athlete. */
  division: Division | null;
  eventId: string | null;
  season: string;
  /** Código completo del evento. Pasarlo a /api/athlete como `event`. */
  event: string;
  /** Etiqueta del desplegable de la web: suele ser el día ("HYROX - Saturday"), no la sede. */
  eventLabel: string;
  /** Sede y año ("Valencia 2025"), o null si aún no se conoce. */
  place: string | null;
  rank: number | null;
  name: string;
  nationality: string | null;
  city: string | null;
  year: number | null;
  ageGroup: string | null;
  totalTime: string | null;
  totalSec: number | null;
}

/**
 * Cada palabra buscada tiene que ser el comienzo de alguna palabra del nombre, en
 * cualquier orden y sin acentos: "ana per" encuentra "Pérez García, Ana".
 * A diferencia del buscador de la web, también encuentra al segundo miembro de un
 * equipo de dobles, porque su nombre está en la fila del equipo.
 */
export function searchQuery(q: string, opts: { division?: Division; limit: number }) {
  const tokens = nameTokens(q).slice(0, 6);
  const params: unknown[] = [];
  const where = tokens.map((t) => {
    params.push(`% ${t}%`);
    return `(' ' || r.name_norm) LIKE $${params.length}`;
  });
  if (opts.division) {
    params.push(opts.division);
    where.push(`e.division = $${params.length}`);
  }
  params.push(normalizeName(q));
  const exact = `$${params.length}`;
  params.push(opts.limit);
  const text = `
    SELECT r.idp, r.event_code, r.season, r.name, r.nationality, r.age_group, r.city, r.year,
           r.rank, r.total_sec, e.label, e.division, e.place
    FROM results r JOIN events e ON e.code = r.event_code
    WHERE ${where.join(' AND ')}
    ORDER BY (r.name_norm = ${exact}) DESC, r.name_norm, r.season DESC, r.total_sec NULLS LAST
    LIMIT $${params.length}`;
  return { text, params, empty: tokens.length === 0 };
}

export function secToHms(sec: number | null): string | null {
  if (sec === null || sec === undefined) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

/** Fila de results (+ label y division del evento) -> hit con el formato de /api/search. */
function toHit(r: Record<string, any>): DbHit {
  const code = r.event_code as string;
  const division = (r.division as Division | null) ?? null;
  return {
    idp: r.idp,
    division,
    eventId: division ? code.slice(code.indexOf('_') + 1) : null,
    season: r.season,
    event: code,
    eventLabel: r.label,
    place: r.place || null,
    rank: r.rank,
    name: r.name,
    nationality: r.nationality,
    city: r.city,
    year: r.year,
    ageGroup: r.age_group,
    totalTime: secToHms(r.total_sec),
    totalSec: r.total_sec,
  };
}

export async function searchDb(db: Query, q: string, opts: { division?: Division; limit: number }): Promise<DbHit[]> {
  const { text, params, empty } = searchQuery(q, opts);
  if (empty) return [];
  return (await db(text, params)).map(toHit);
}

// --------------------------------------------------------------------------- eventos

export type EventStatus = 'available' | 'upcoming' | 'pending';

export interface RaceDivision {
  /** Código completo, para /api/event?code=… */
  code: string;
  division: Division | null;
  /** Prefijo del código (H, HPRO, HD, HE…): identifica la división aunque no sea conocida. */
  prefix: string;
  label: string;
  results: number | null;
  /** available: con resultados · upcoming: publicada sin resultados · pending: aún no descargada */
  status: EventStatus;
}

export interface Race {
  /** La sede si se conoce; si no, la parte común de los códigos (H_X, HPRO_X -> X). */
  id: string;
  season: string;
  /** La sede ("2026 Stockholm"); si aún no se conoce, la etiqueta de la web. */
  name: string;
  place: string | null;
  status: EventStatus;
  results: number;
  divisions: RaceDivision[];
}

function statusOf(rowCount: number | null): EventStatus {
  if (rowCount === null || rowCount === undefined) return 'pending';
  return rowCount > 0 ? 'available' : 'upcoming';
}

/** Cuenta de eventos y resultados por temporada, de la más reciente a la más antigua. */
export async function listSeasons(db: Query): Promise<{ season: string; races: number; results: number }[]> {
  const rows = await db(
    `SELECT season, count(DISTINCT coalesce(place, substr(code, strpos(code, '_') + 1)))::int AS races,
            coalesce(sum(row_count), 0)::int AS results
     FROM events GROUP BY season
     ORDER BY substring(season from '[0-9]+')::int DESC`,
  );
  return rows.map((r) => ({ season: r.season, races: r.races, results: r.results }));
}

/**
 * Carreras de una temporada, agrupadas por sede (el <optgroup> del desplegable de la
 * web). Una sede tiene varios eventos: uno por división y día (H_X "HYROX - Friday",
 * HD1_Y "HYROX DOUBLES - Saturday"...), y no siempre comparten código. Sin sede
 * conocida se agrupa por la parte común del código.
 * En el orden del desplegable, que va de la más reciente a la más antigua.
 */
export async function listRaces(db: Query, season: string): Promise<Race[]> {
  const rows = await db(
    `SELECT code, label, division, row_count, position, place FROM events
     WHERE season = $1 ORDER BY position NULLS LAST, code`,
    [season],
  );
  const races = new Map<string, Race>();
  for (const r of rows) {
    const code = r.code as string;
    const cut = code.indexOf('_');
    const place = (r.place as string | null) || null;
    const id = place ?? code.slice(cut + 1);
    let race = races.get(id);
    if (!race) {
      race = { id, season, name: place ?? r.label, place, status: 'pending', results: 0, divisions: [] };
      races.set(id, race);
    }
    race.divisions.push({
      code,
      division: r.division ?? null,
      prefix: code.slice(0, cut),
      label: r.label,
      results: r.row_count ?? null,
      status: statusOf(r.row_count ?? null),
    });
    race.results += r.row_count ?? 0;
  }
  for (const race of races.values()) {
    const statuses = new Set(race.divisions.map((d) => d.status));
    race.status = statuses.has('available') ? 'available' : statuses.has('pending') ? 'pending' : 'upcoming';
  }
  return [...races.values()];
}

/** Clasificación de un evento (una división), opcionalmente filtrada por nombre. */
export async function eventResults(
  db: Query,
  code: string,
  opts: { q?: string; limit: number; offset: number },
): Promise<{ event: RaceDivision & { season: string; place: string | null } | null; total: number; results: DbHit[] }> {
  const ev = (await db(`SELECT code, season, label, division, row_count, place FROM events WHERE code = $1`, [code]))[0];
  if (!ev) return { event: null, total: 0, results: [] };

  const params: unknown[] = [code];
  const where = ['r.event_code = $1'];
  for (const token of nameTokens(opts.q ?? '').slice(0, 6)) {
    params.push(`% ${token}%`);
    where.push(`(' ' || r.name_norm) LIKE $${params.length}`);
  }
  const total = (await db(`SELECT count(*)::int AS n FROM results r WHERE ${where.join(' AND ')}`, params))[0].n as number;
  params.push(opts.limit, opts.offset);
  const rows = await db(
    `SELECT r.idp, r.event_code, r.season, r.name, r.nationality, r.age_group, r.city, r.year,
            r.rank, r.total_sec, e.label, e.division, e.place
     FROM results r JOIN events e ON e.code = r.event_code
     WHERE ${where.join(' AND ')}
     ORDER BY r.rank NULLS LAST, r.total_sec NULLS LAST, r.name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const cut = code.indexOf('_');
  return {
    event: {
      code,
      season: ev.season,
      division: ev.division ?? null,
      prefix: code.slice(0, cut),
      label: ev.label,
      place: ev.place || null,
      results: ev.row_count ?? null,
      status: statusOf(ev.row_count ?? null),
    },
    total,
    results: rows.map(toHit),
  };
}

// --------------------------------------------------------------------------- estado

/** Límite de almacenamiento del plan gratuito de Neon. */
export const NEON_FREE_BYTES = 512 * 1024 * 1024;

export interface DbStats {
  totalMB: number;
  /** Porcentaje usado del plan gratuito de Neon (0,5 GB). */
  freePlanUsedPct: number;
  tables: Record<string, { mb: number; rows: number }>;
  events: { total: number; completed: number; withResults: number };
  seasons: { season: string; results: number }[];
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Tamaño y volumen de la base de datos. Las filas de cada tabla son la estimación de
 * Postgres (pg_class.reltuples), que no recorre la tabla: basta para vigilar el espacio.
 */
export async function dbStats(db: Query): Promise<DbStats> {
  const [size] = await db(`SELECT pg_database_size(current_database())::bigint AS bytes`);
  const tables = await db(
    `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes,
            greatest(c.reltuples, 0)::bigint AS rows
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('results', 'events', 'details')`,
  );
  const [events] = await db(
    `SELECT count(*)::int AS total,
            count(completed_at)::int AS completed,
            count(*) FILTER (WHERE row_count > 0)::int AS with_results
     FROM events`,
  );
  const seasons = await db(
    `SELECT season, coalesce(sum(row_count), 0)::int AS results FROM events
     GROUP BY season ORDER BY substring(season from '[0-9]+')::int DESC`,
  );
  const bytes = Number(size.bytes);
  return {
    totalMB: mb(bytes),
    freePlanUsedPct: Math.round((bytes / NEON_FREE_BYTES) * 1000) / 10,
    tables: Object.fromEntries(tables.map((t) => [t.name, { mb: mb(Number(t.bytes)), rows: Number(t.rows) }])),
    events: { total: events.total, completed: events.completed, withResults: events.with_results },
    seasons: seasons.map((r) => ({ season: r.season, results: r.results })),
  };
}

// --------------------------------------------------------------------------- caché de detalle

export async function getCachedDetail<T>(db: Query, key: string): Promise<T | null> {
  const rows = await db(`SELECT data FROM details WHERE cache_key = $1`, [key]);
  return rows.length ? (rows[0].data as T) : null;
}

export async function saveDetail(db: Query, key: string, data: unknown): Promise<void> {
  await db(
    `INSERT INTO details (cache_key, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
    [key, JSON.stringify(data)],
  );
}
