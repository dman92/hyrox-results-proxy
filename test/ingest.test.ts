import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { run, parseArgs, parseEventOptions } from '../scripts/ingest.ts';
import { pendingEventCodes, searchDb, type Query } from '../lib/db.ts';

// Web falsa con el mismo marcado que results.hyrox.com (ver lib/hyrox.ts parseListRows)
const selectPage = (codes: string[]) =>
  `<select name="event"><optgroup label="2025 Valencia">${codes.map((c) => `<option value="${c}">HYROX ${c}</option>`).join('')}</optgroup></select>`;

const listPage = (prefix: string, from: number, count: number) =>
  '<ul>' +
  Array.from({ length: count }, (_, k) => {
    const n = from + k;
    return `<li class="list-group-item row">
      <div class="type-place place-primary">${n}</div>
      <h4 class="type-fullname"><a href="?content=detail&amp;idp=${prefix}${n}&amp;pid=list">Atleta${n}, Nombre</a></h4>
      <div class="type-nation_flag"><span class="nation__abbr">ESP</span></div>
      <div class="type-age_class">30-34</div>
      <div class="type-time"><div class="list-label">Total</div>01:0${n % 10}:00</div>
    </li>`;
  }).join('') +
  '</ul>';

function fakeHyrox() {
  const calls: URL[] = [];
  const fetchMock = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const event = url.searchParams.get('event');
    const page = Number(url.searchParams.get('page') ?? 1);
    if (!event) return new Response(selectPage(['H_A', 'H_A_OVERALL', 'HD1_B', 'H_BAD', 'H_FUTURE']));
    if (event === 'H_FUTURE') return new Response('<p>No results</p>');
    if (event === 'H_BAD') return new Response('boom', { status: 404 });
    if (event === 'H_A') return new Response(listPage('A', (page - 1) * 100 + 1, page === 1 ? 100 : page === 2 ? 50 : 0));
    if (event === 'HD1_B') return new Response(page === 1 ? listPage('B', 1, 1) : '<ul></ul>');
    return new Response('?', { status: 500 });
  };
  return { calls, fetchMock };
}

const url = process.env.TEST_DATABASE_URL;

test('ingesta completa a Postgres: reanuda, salta _OVERALL y aísla eventos rotos',
  { skip: !url && 'sin TEST_DATABASE_URL' }, async (t) => {
  const pool = new pg.Pool({ connectionString: url });
  const db: Query = async (text, params = []) => (await pool.query(text, params)).rows;
  const { calls, fetchMock } = fakeHyrox();
  t.mock.method(globalThis, 'fetch', fetchMock);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const args = parseArgs(['--season', '8', '--rate', '1000']);

  try {
    await db('DROP TABLE IF EXISTS results, events, details');

    const first = await run(args, db);
    assert.deepEqual(first, { rows: 151, failures: 1 });
    assert.ok(!calls.some((u) => u.searchParams.get('event') === 'H_A_OVERALL'), 'no debe tocar _OVERALL');
    assert.equal((await db('SELECT count(*)::int AS n FROM results'))[0].n, 151);
    // El evento roto y el que aún no tiene resultados siguen pendientes
    assert.deepEqual([...(await pendingEventCodes(db, 'season-8', 10))].sort(), ['H_BAD', 'H_FUTURE']);
    // La sede sale del <optgroup> del desplegable: ni una petición de más
    assert.ok(!calls.some((u) => u.searchParams.get('content') === 'detail'));
    assert.equal((await db(`SELECT place FROM events WHERE code = 'H_A'`))[0].place, '2025 Valencia');

    const hits = await searchDb(db, 'atleta150', { limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].event, 'H_A');
    assert.equal(hits[0].season, 'season-8');
    assert.equal(hits[0].nationality, 'ESP');

    // Segunda ejecución: solo vuelve a mirar el evento roto y el futuro
    calls.length = 0;
    const second = await run(args, db);
    assert.deepEqual(second, { rows: 0, failures: 1 });
    const lists = new Set(calls.map((u) => u.searchParams.get('event')).filter(Boolean));
    assert.deepEqual([...lists].sort(), ['H_BAD', 'H_FUTURE']);

    // Sin tiempo: no empieza ningún evento
    calls.length = 0;
    await run(parseArgs(['--season', '8', '--rate', '1000', '--max-minutes', '0.000001']), db);
    assert.ok(!calls.some((u) => u.searchParams.get('event')));
  } finally {
    await db('DROP TABLE IF EXISTS results, events, details');
    await pool.end();
  }
});

test('parseEventOptions: sede del optgroup, etiqueta de la opción y sin _OVERALL', () => {
  // Estructura real del desplegable de results.hyrox.com/season-8/?pid=list (recortado)
  const html = `<select name="event" id="event">
    <optgroup label="2026 Stockholm">
      <option value="HE_LR3MS4JI1646">HYROX ELITE 15 - Thursday</option>
      <option value="HD1_LR3MS4JI163B">HYROX DOUBLES - Saturday</option>
    </optgroup>
    <optgroup label="2026 Berlin">
      <option value="HPRO_LR3MS4JI1632">HYROX PRO - Fri, 22 May</option>
      <option value="HPRO_BER26_OVERALL">HYROX PRO - Overall</option>
    </optgroup>
    <optgroup label="2025 Singapore"><option value="H_LR3MS4JIBB9">HYROX</option></optgroup>
  </select>
  <select name="ranking"><option value="time_finish_netto">Total</option></select>`;
  assert.deepEqual(parseEventOptions(html), [
    { code: 'HE_LR3MS4JI1646', label: 'HYROX ELITE 15 - Thursday', place: '2026 Stockholm' },
    { code: 'HD1_LR3MS4JI163B', label: 'HYROX DOUBLES - Saturday', place: '2026 Stockholm' },
    { code: 'HPRO_LR3MS4JI1632', label: 'HYROX PRO - Fri, 22 May', place: '2026 Berlin' },
    { code: 'H_LR3MS4JIBB9', label: 'HYROX', place: '2025 Singapore' },
  ]);
  // Sin optgroup, sede null
  assert.deepEqual(parseEventOptions('<select name="event"><option value="H_X">HYROX</option></select>'),
    [{ code: 'H_X', label: 'HYROX', place: null }]);
});
