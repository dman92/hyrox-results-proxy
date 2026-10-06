import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { run, parseArgs, isEliteEvent } from '../scripts/ingest.ts';
import { eliteRaces, migrate, type Query } from '../lib/db.ts';

// Web falsa: una sede con Elite 15 individual y dobles, y una carrera normal
const select = `<select name="event"><optgroup label="2026 Stockholm">
  <option value="HE_S">HYROX ELITE 15 - Thursday</option>
  <option value="HDE_S">HYROX ELITE 15 DOUBLES - Friday</option>
  <option value="H_S">HYROX - Friday</option>
</optgroup></select>`;

const athletes: Record<string, { idp: string; name: string; sex: 'M' | 'W'; time: string }[]> = {
  HE_S: [
    { idp: 'E1', name: 'Fast, Man', sex: 'M', time: '00:56:10' },
    { idp: 'E2', name: 'Quick, Woman', sex: 'W', time: '01:01:00' },
    { idp: 'E3', name: 'Slower, Man', sex: 'M', time: '00:58:00' },
  ],
  HDE_S: [{ idp: 'D1', name: 'Pair, One / Pair, Two', sex: 'W', time: '00:59:00' }],
  H_S: [{ idp: 'O1', name: 'Open, Ana', sex: 'W', time: '01:20:00' }],
};

const list = (rows: { idp: string; name: string; time: string }[]) =>
  '<ul>' + rows.map((r, i) => `<li class="list-group-item row">
    <div class="type-place place-primary">${i + 1}</div>
    <h4 class="type-fullname"><a href="?content=detail&amp;idp=${r.idp}&amp;pid=list">${r.name}</a></h4>
    <div class="type-time"><div class="list-label">Total</div>${r.time}</div>
  </li>`).join('') + '</ul>';

const url = process.env.TEST_DATABASE_URL;

test('isEliteEvent: por la etiqueta del desplegable', () => {
  assert.ok(isEliteEvent({ label: 'HYROX ELITE 15 - Thursday' }));
  assert.ok(isEliteEvent({ label: 'HYROX ELITE 15 DOUBLES - Friday' }));
  assert.ok(!isEliteEvent({ label: 'HYROX PRO - Friday' }));
});

test('elite: la ingesta saca el sexo filtrando y /api/elite agrupa y ordena',
  { skip: !url && 'sin TEST_DATABASE_URL' }, async (t) => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Query = async (text, params = []) => (await pool.query(text, params)).rows;
  const calls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u);
    const event = u.searchParams.get('event');
    if (!event) return new Response(select);
    if (Number(u.searchParams.get('page') ?? 1) > 1) return new Response('<ul></ul>');
    const sex = u.searchParams.get('search[sex]');
    return new Response(list((athletes[event] ?? []).filter((a) => !sex || a.sex === sex)));
  });
  t.mock.method(console, 'log', () => {});

  try {
    await db('DROP TABLE IF EXISTS results, events, details');
    await run(parseArgs(['--season', '9', '--rate', '1000']), db);

    // Solo los eventos elite se piden filtrados por sexo
    const filtered = new Set(calls.filter((u) => u.searchParams.get('search[sex]')).map((u) => u.searchParams.get('event')));
    assert.deepEqual([...filtered].sort(), ['HDE_S', 'HE_S']);
    const sexes = await db(`SELECT idp, sex FROM results ORDER BY idp`);
    assert.deepEqual(sexes.map((r) => [r.idp, r.sex]), [['D1', 'W'], ['E1', 'M'], ['E2', 'W'], ['E3', 'M'], ['O1', null]]);

    const races = await eliteRaces(db, 5);
    assert.equal(races.length, 1);
    assert.equal(races[0].name, '2026 Stockholm');
    assert.deepEqual(races[0].divisions.map((d) => [d.code, d.doubles]), [['HE_S', false], ['HDE_S', true]]);
    const single = races[0].divisions[0].results;
    assert.deepEqual(single.map((r) => [r.idp, r.sex, r.position]), [['E1', 'M', 1], ['E3', 'M', 2], ['E2', 'W', 1]]);
    assert.equal(single[0].event, 'HE_S');

    // Un evento elite volcado antes de saber el sexo se reabre una sola vez
    await db(`UPDATE events SET sex_checked = false WHERE code = 'HE_S'`);
    await migrate(db);
    assert.equal((await db(`SELECT completed_at FROM events WHERE code = 'HE_S'`))[0].completed_at, null);
    await run(parseArgs(['--season', '9', '--rate', '1000']), db);
    await migrate(db);
    assert.notEqual((await db(`SELECT completed_at FROM events WHERE code = 'HE_S'`))[0].completed_at, null);
  } finally {
    await db('DROP TABLE IF EXISTS results, events, details');
    await pool.end();
  }
});
