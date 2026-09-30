import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { detailUrl, splitEventCode, type ListRow } from '../lib/hyrox.ts';
import {
  eventResults, getCachedDetail, listRaces, listSeasons, migrate, nameTokens, normalizeName,
  pendingEventCodes, saveDetail, saveEventRows, searchDb, secToHms, upsertEvents, type Query,
} from '../lib/db.ts';

test('normalizeName ignora acentos, mayúsculas y orden', () => {
  assert.deepEqual(nameTokens('Pérez García, Ana'), ['perez', 'garcia', 'ana']);
  assert.equal(normalizeName('Pérez García, Ana'), normalizeName('ana GARCIA perez'));
});

test('splitEventCode reconoce divisiones y deja pasar prefijos desconocidos', () => {
  assert.deepEqual(splitEventCode('HPRO_LR3MS4JIAA2'), { division: 'pro', eventId: 'LR3MS4JIAA2' });
  assert.deepEqual(splitEventCode('H_LR3MS4JIAA2'), { division: 'open', eventId: 'LR3MS4JIAA2' });
  assert.deepEqual(splitEventCode('HD1_LR3MS4JI1760'), { division: null, eventId: 'LR3MS4JI1760' });
});

test('detailUrl con código de evento completo', () => {
  const url = detailUrl('ABC123', 'open', null, 'season-8', 'HD1_LR3MS4JI1760');
  assert.match(url, /season-8\/\?/);
  assert.match(url, /pid=list&/);
  assert.match(url, /event=HD1_LR3MS4JI1760/);
  // Sin código completo se mantiene el comportamiento anterior
  assert.match(detailUrl('ABC123', 'pro'), /event=HPRO_HYROXOVERALL/);
});

test('secToHms', () => {
  assert.equal(secToHms(3912), '01:05:12');
  assert.equal(secToHms(null), null);
});

// ---------------------------------------------------------------------------
// Contra Postgres de verdad: TEST_DATABASE_URL=postgres://... npm test
const url = process.env.TEST_DATABASE_URL;

const row = (idp: string, name: string, totalSec: number | null, extra: Partial<ListRow> = {}): ListRow => ({
  idp, name, rank: 1, nationality: 'ESP', city: null, year: null, ageGroup: '30-34',
  totalTime: secToHms(totalSec), totalSec, ...extra,
});

test('ingesta y búsqueda en Postgres', { skip: !url && 'sin TEST_DATABASE_URL' }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Query = async (text, params = []) => (await pool.query(text, params)).rows;
  try {
    await db('DROP TABLE IF EXISTS results, events, details');
    await migrate(db);
    await migrate(db); // idempotente

    // Carga inicial de una temporada: nada se marca para refrescar
    await upsertEvents(db, 'season-8', [
      { code: 'H_VAL25', label: '2025 Valencia', division: 'open', place: null },
      { code: 'HD_VAL25', label: '2025 Valencia', division: 'doubles', place: null },
      { code: 'HD1_VAL25', label: '2025 Valencia', division: null, place: null },
    ]);
    assert.equal((await pendingEventCodes(db, 'season-8', 10)).size, 3);

    const valRows = [
      row('ID1', 'Pérez García, Ana', 3912),
      row('ID2', 'Smith, John', 4203, { nationality: 'GBR', rank: 2 }),
      row('ID3', 'Perez, Anabel', null, { rank: null }),
    ];
    await saveEventRows(db, 'season-8', 'H_VAL25', valRows);
    await saveEventRows(db, 'season-8', 'HD_VAL25', [row('ID9', 'Lee, Brent / Ectin, Ritzy Amor', 3500)]);
    await saveEventRows(db, 'season-8', 'HD1_VAL25', [row('ID7', 'García, Ana', 3000)]);
    // Repetir un evento no duplica filas
    await saveEventRows(db, 'season-8', 'H_VAL25', valRows);
    assert.equal((await db('SELECT count(*)::int AS n FROM results'))[0].n, 5);

    // Completados y de la carga inicial: ya no están pendientes
    assert.equal((await pendingEventCodes(db, 'season-8', 10)).size, 0);

    // Un evento nuevo en una temporada ya volcada sí se refresca
    // (la ingesta siempre manda el desplegable entero, en su orden)
    await upsertEvents(db, 'season-8', [
      { code: 'H_VAL25', label: '2025 Valencia', division: 'open', place: null },
      { code: 'HD_VAL25', label: '2025 Valencia', division: 'doubles', place: null },
      { code: 'HD1_VAL25', label: '2025 Valencia', division: null, place: null },
      { code: 'H_BCN26', label: '2026 Barcelona', division: 'open', place: null },
    ]);
    assert.deepEqual([...(await pendingEventCodes(db, 'season-8', 10))], ['H_BCN26']);
    assert.equal((await db(`SELECT refresh FROM events WHERE code = 'H_VAL25'`))[0].refresh, false);
    assert.equal((await db(`SELECT refresh FROM events WHERE code = 'H_BCN26'`))[0].refresh, true);

    // Búsqueda: sin acentos, en cualquier orden, por prefijo; exacta primero
    const hits = await searchDb(db, 'ana perez', { limit: 10 });
    assert.deepEqual(hits.map((h) => h.idp), ['ID1', 'ID3']);
    const ana = hits[0];
    assert.equal(ana.season, 'season-8');
    assert.equal(ana.event, 'H_VAL25');
    assert.equal(ana.eventId, 'VAL25');
    assert.equal(ana.division, 'open');
    assert.equal(ana.eventLabel, '2025 Valencia');
    assert.equal(ana.totalTime, '01:05:12');
    assert.equal((await searchDb(db, 'garc AN', { limit: 10 }))[0].idp, 'ID7'); // exacta: "García, Ana"

    // El segundo miembro de un equipo de dobles también se encuentra
    const ectin = await searchDb(db, 'ectin', { limit: 10 });
    assert.equal(ectin.length, 1);
    assert.equal(ectin[0].division, 'doubles');

    // Prefijo de división desconocido: division/eventId null, event completo
    const hd1 = (await searchDb(db, 'garcia ana', { limit: 10 })).find((h) => h.idp === 'ID7')!;
    assert.equal(hd1.division, null);
    assert.equal(hd1.eventId, null);
    assert.equal(hd1.event, 'HD1_VAL25');

    assert.deepEqual((await searchDb(db, 'ana', { division: 'doubles', limit: 10 })), []);
    assert.deepEqual(await searchDb(db, '!!', { limit: 10 }), []);

    // Carreras: divisiones agrupadas por la parte común del código, en orden de la web
    await upsertEvents(db, 'season-9', [
      { code: 'H_NEXT', label: '2026 Madrid', division: 'open', place: null },
      { code: 'HPRO_NEXT', label: '2026 Madrid', division: 'pro', place: null },
    ]);
    await saveEventRows(db, 'season-9', 'H_NEXT', []); // aún sin resultados
    const races8 = await listRaces(db, 'season-8');
    assert.deepEqual(races8.map((r) => r.id), ['VAL25', 'BCN26']);
    const val = races8[0];
    assert.equal(val.name, '2025 Valencia');
    assert.equal(val.status, 'available');
    assert.equal(val.results, 5);
    assert.deepEqual(val.divisions.map((d) => [d.code, d.prefix, d.division, d.results, d.status]), [
      ['H_VAL25', 'H', 'open', 3, 'available'],
      ['HD_VAL25', 'HD', 'doubles', 1, 'available'],
      ['HD1_VAL25', 'HD1', null, 1, 'available'],
    ]);
    assert.equal(races8[1].status, 'pending');
    const [madrid] = await listRaces(db, 'season-9');
    assert.equal(madrid.status, 'pending'); // una división sin resultados, otra sin descargar
    assert.deepEqual(madrid.divisions.map((d) => d.status), ['upcoming', 'pending']);

    assert.deepEqual(await listSeasons(db), [
      { season: 'season-9', races: 1, results: 0 },
      { season: 'season-8', races: 2, results: 5 },
    ]);

    // La sede viene del <optgroup> de la web; agrupa eventos de la misma sede aunque sus
    // códigos no compartan sufijo, y no se pierde si una ingesta posterior no la trae
    const withPlaces = [
      { code: 'H_VAL25', label: 'HYROX - Saturday', division: 'open' as const, place: '2025 Valencia' },
      { code: 'HD_VAL25', label: 'HYROX DOUBLES - Saturday', division: 'doubles' as const, place: '2025 Valencia' },
      { code: 'HD1_VAL26', label: 'HYROX DOUBLES - Sunday', division: null, place: '2025 Valencia' },
      { code: 'HD1_VAL25', label: '2025 Valencia', division: null, place: '2025 Valencia' as string | null },
      { code: 'H_BCN26', label: '2026 Barcelona', division: 'open' as const, place: null },
    ];
    await upsertEvents(db, 'season-8', withPlaces);
    // Una ingesta posterior que no trae la sede no la borra
    await upsertEvents(db, 'season-8', withPlaces.map((e) => (e.code === 'HD1_VAL25' ? { ...e, place: null } : e)));
    const races8b = await listRaces(db, 'season-8');
    assert.deepEqual(races8b.map((r) => [r.id, r.name, r.divisions.map((d) => d.code).join(',')]), [
      ['2025 Valencia', '2025 Valencia', 'H_VAL25,HD_VAL25,HD1_VAL26,HD1_VAL25'],
      ['BCN26', '2026 Barcelona', 'H_BCN26'],
    ]);
    assert.equal((await db(`SELECT place FROM events WHERE code = 'HD1_VAL25'`))[0].place, '2025 Valencia'); // coalesce
    assert.equal((await searchDb(db, 'smith', { limit: 1 }))[0].place, '2025 Valencia');
    assert.deepEqual((await listSeasons(db)).find((x) => x.season === 'season-8'), { season: 'season-8', races: 2, results: 5 });

    // Clasificación de un evento, con filtro por nombre y paginación
    const board = await eventResults(db, 'H_VAL25', { limit: 2, offset: 0 });
    assert.equal(board.total, 3);
    assert.equal(board.event!.label, 'HYROX - Saturday');
    assert.equal(board.event!.place, '2025 Valencia');
    assert.equal(board.event!.status, 'available');
    assert.deepEqual(board.results.map((r) => r.idp), ['ID1', 'ID2']);
    assert.equal(board.results[0].event, 'H_VAL25');
    assert.deepEqual((await eventResults(db, 'H_VAL25', { limit: 2, offset: 2 })).results.map((r) => r.idp), ['ID3']);
    const filtered = await eventResults(db, 'H_VAL25', { q: 'smith', limit: 10, offset: 0 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.results[0].name, 'Smith, John');
    assert.equal((await eventResults(db, 'H_NOPE', { limit: 10, offset: 0 })).event, null);

    // Caché de detalle
    assert.equal(await getCachedDetail(db, 'k'), null);
    await saveDetail(db, 'k', { idp: 'ID1', splits: [1, 2] });
    await saveDetail(db, 'k', { idp: 'ID1', splits: [1, 2, 3] });
    assert.deepEqual(await getCachedDetail(db, 'k'), { idp: 'ID1', splits: [1, 2, 3] });

    // Usa el índice trigram
    await db('SET enable_seqscan = off');
    const plan = (await db(`EXPLAIN SELECT 1 FROM results r WHERE (' ' || r.name_norm) LIKE '% ana%'`))
      .map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /results_name_trgm/);
  } finally {
    await db('DROP TABLE IF EXISTS results, events, details');
    await pool.end();
  }
});

test('dbStats: tamaño y volumen', { skip: !url && 'sin TEST_DATABASE_URL' }, async () => {
  const { dbStats } = await import('../lib/db.ts');
  const pool = new pg.Pool({ connectionString: url });
  const db: Query = async (text, params = []) => (await pool.query(text, params)).rows;
  try {
    await db('DROP TABLE IF EXISTS results, events, details');
    await migrate(db);
    await upsertEvents(db, 'season-8', [{ code: 'H_A', label: 'HYROX', division: 'open', place: '2025 Valencia' }]);
    await saveEventRows(db, 'season-8', 'H_A', [row('X1', 'Ruiz, Eva', 3900)]);
    await db('ANALYZE');
    const stats = await dbStats(db);
    assert.ok(stats.totalMB > 0);
    assert.ok(stats.freePlanUsedPct > 0 && stats.freePlanUsedPct < 100);
    assert.deepEqual(Object.keys(stats.tables).sort(), ['details', 'events', 'results']);
    assert.equal(stats.tables.results.rows, 1);
    assert.deepEqual(stats.events, { total: 1, completed: 1, withResults: 1 });
    assert.deepEqual(stats.seasons, [{ season: 'season-8', results: 1 }]);
  } finally {
    await db('DROP TABLE IF EXISTS results, events, details');
    await pool.end();
  }
});
