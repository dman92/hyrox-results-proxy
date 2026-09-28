import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { detailUrl, splitEventCode, type ListRow } from '../lib/hyrox.ts';
import {
  getCachedDetail, migrate, nameTokens, normalizeName, pendingEventCodes, saveDetail,
  saveEventRows, searchDb, secToHms, upsertEvents, type Query,
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
      { code: 'H_VAL25', label: '2025 Valencia', division: 'open' },
      { code: 'HD_VAL25', label: '2025 Valencia', division: 'doubles' },
      { code: 'HD1_VAL25', label: '2025 Valencia', division: null },
    ]);
    assert.equal((await pendingEventCodes(db, 'season-8', 10)).size, 3);

    await saveEventRows(db, 'season-8', 'H_VAL25', [
      row('ID1', 'Pérez García, Ana', 3912),
      row('ID2', 'Smith, John', 4203, { nationality: 'GBR' }),
      row('ID3', 'Perez, Anabel', null),
    ]);
    await saveEventRows(db, 'season-8', 'HD_VAL25', [row('ID9', 'Lee, Brent / Ectin, Ritzy Amor', 3500)]);
    await saveEventRows(db, 'season-8', 'HD1_VAL25', [row('ID7', 'García, Ana', 3000)]);
    // Repetir un evento no duplica filas
    await saveEventRows(db, 'season-8', 'H_VAL25', [row('ID1', 'Pérez García, Ana', 3912)]);
    assert.equal((await db('SELECT count(*)::int AS n FROM results'))[0].n, 5);

    // Completados y de la carga inicial: ya no están pendientes
    assert.equal((await pendingEventCodes(db, 'season-8', 10)).size, 0);

    // Un evento nuevo en una temporada ya volcada sí se refresca
    await upsertEvents(db, 'season-8', [{ code: 'H_BCN26', label: '2026 Barcelona', division: 'open' }]);
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
