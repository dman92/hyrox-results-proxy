import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { searchPeople } from '../lib/athletes.ts';
import { migrate, saveEventRows, searchDb, secToHms, upsertEvents, type Query } from '../lib/db.ts';
import type { ListRow } from '../lib/hyrox.ts';

const url = process.env.TEST_DATABASE_URL;
const row = (idp: string, name: string, totalSec: number): ListRow => ({
  idp, name, rank: 1, nationality: null, city: null, year: null, ageGroup: '30-34', totalTime: secToHms(totalSec), totalSec,
});

test('búsqueda por persona en dobles contra Postgres', { skip: !url && 'sin TEST_DATABASE_URL' }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Query = async (text, params = []) => (await pool.query(text, params)).rows;
  try {
    await db('DROP TABLE IF EXISTS results, events, details');
    await migrate(db);
    await upsertEvents(db, 'season-8', [
      { code: 'HD_A', label: 'HYROX DOUBLES - Saturday', division: 'doubles', place: null },
      { code: 'HD_B', label: 'HYROX DOUBLES - Saturday', division: 'doubles', place: null },
      { code: 'HDP_C', label: 'HYROX PRO DOUBLES', division: 'pro_doubles', place: null },
      { code: 'HDP_PARIS25_OVERALL_2', label: 'HYROX PRO DOUBLES - Overall', division: 'pro_doubles', place: null },
    ]);
    await upsertEvents(db, 'season-9', [{ code: 'HD_D', label: 'HYROX DOUBLES - Saturday', division: 'doubles', place: null }]);
    await saveEventRows(db, 'season-8', 'HD_A', [row('A1', 'Lucía Pérez García, David Manso Garcia', 4648)]);
    await saveEventRows(db, 'season-8', 'HD_B', [row('B1', 'Lucia Perez, David Manso', 5264)]);
    await saveEventRows(db, 'season-9', 'HD_D', [row('D1', 'David Manso, Lucia Perez', 4717)]);
    // Muchos falsos positivos ("david" en un miembro, "manso" en "Mansouri" del otro)
    await saveEventRows(db, 'season-8', 'HDP_C', Array.from({ length: 30 }, (_, i) =>
      row('C' + i, `Karim Mansouri${i}, David Martin`, 4000 + i)));
    await saveEventRows(db, 'season-8', 'HDP_PARIS25_OVERALL_2', [row('O1', 'David Manso, Lucia Perez', 4717)]);

    // La migración borra los rankings agregados con sufijo
    await migrate(db);
    assert.equal((await db(`SELECT count(*)::int AS n FROM events WHERE code LIKE '%OVERALL%'`))[0].n, 0);
    assert.equal((await db(`SELECT count(*)::int AS n FROM results WHERE idp = 'O1'`))[0].n, 0);

    const fetchRows = (n: number) => searchDb(db, 'david manso', { limit: n });
    // Sin agrupar, los falsos positivos llenan el límite
    assert.ok((await fetchRows(5)).some((h) => h.name.includes('Mansouri')));

    const { hits, athletes } = await searchPeople(fetchRows, 'david manso', 5);
    assert.deepEqual(hits.map((h) => h.idp).sort(), ['A1', 'B1', 'D1']);
    assert.equal(athletes.length, 1);
    const [me] = athletes;
    assert.equal(me.name, 'David Manso Garcia');
    assert.equal(me.count, 3);
    assert.deepEqual(me.results.map((r) => [r.idp, r.season, r.partners[0]]).sort(), [
      ['A1', 'season-8', 'Lucía Pérez García'],
      ['B1', 'season-8', 'Lucia Perez'],
      ['D1', 'season-9', 'Lucia Perez'],
    ]);
    // Cada resultado conserva lo necesario para abrir sus splits
    assert.equal(me.results.find((r) => r.idp === 'D1')!.event, 'HD_D');
  } finally {
    await db('DROP TABLE IF EXISTS results, events, details');
    await pool.end();
  }
});
