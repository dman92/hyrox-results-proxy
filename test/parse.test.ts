import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseDetail, parseListRows, hmsToSec, canonicalKey, dedupeNameParts } from '../lib/hyrox.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('hmsToSec', () => {
  assert.equal(hmsToSec('00:59:17'), 3557);
  assert.equal(hmsToSec('04:16'), 256);
  assert.equal(hmsToSec('basura'), null);
  // Elite 15: centésimas, que se descartan
  assert.equal(hmsToSec('53:47.18'), 3227);
  assert.equal(hmsToSec('00:56:59.49'), 3419);
});

test('canonicalKey normaliza etiquetas de mika', () => {
  assert.equal(canonicalKey('Running 3'), 'run_3');
  assert.equal(canonicalKey('1000m SkiErg'), 'ski_erg');
  assert.equal(canonicalKey('80m Burpee Broad Jump'), 'burpee_broad_jump');
  assert.equal(canonicalKey('100m Sandbag Lunges'), 'sandbag_lunges');
  assert.equal(canonicalKey('Roxzone Time'), 'roxzone');
});

test('parseSearch extrae carreras del ranking all-time', () => {
  const hits = parseSearch(fx('search-overall.html'), 'pro');
  assert.ok(hits.length > 10, `esperaba varias filas, hay ${hits.length}`);

  const h = hits[0];
  assert.match(h.idp, /^[A-Za-z0-9]+$/);
  assert.match(h.name, /,/);                 // "Apellido, Nombre"
  assert.ok(h.year && h.year >= 2018);
  assert.ok(h.city && h.city.length > 1);
  assert.ok(h.totalSec && h.totalSec > 1800);
  assert.equal(h.division, 'pro');

  // Ninguna fila puede ser la cabecera de la tabla
  assert.ok(!hits.some((x) => /^(Total|Time|City)$/i.test(x.name)), 'se coló la cabecera');
});

test('parseDetail (individual) saca los 8 runs, 8 estaciones y roxzone', () => {
  const d = parseDetail(fx('detail-solo.html'), 'LR3MS4JI4A6428OV', 'pro');

  assert.ok(d.name, 'sin nombre');
  assert.equal(d.members.length, 0, 'individual no debería tener members');
  assert.ok(d.validation.ok, `validación falló: ${JSON.stringify(d.validation)}`);

  const keys = new Set(d.splits.map((s) => s.key));
  for (let i = 1; i <= 8; i++) assert.ok(keys.has(`run_${i}`), `falta run_${i}`);
  for (const k of ['ski_erg','sled_push','sled_pull','burpee_broad_jump',
                   'row_erg','farmers_carry','sandbag_lunges','wall_balls','roxzone']) {
    assert.ok(keys.has(k), `falta ${k}`);
  }

  // La suma de los 8 runs tiene que cuadrar con Run Total
  assert.equal(d.validation.runSumMatchesRunTotal, true);

  // Los puestos mundiales por estación son lo que da el diagnóstico
  assert.ok(d.splits.find((s) => s.key === 'ski_erg')!.place! > 0);
});

test('parseDetail (dobles) devuelve el nombre del compañero', () => {
  const d = parseDetail(fx('detail-doubles.html'), 'LR3MS4JI30267DOV', 'doubles');

  assert.equal(d.members.length, 2, 'dobles debe traer 2 miembros');
  for (const m of d.members) {
    assert.ok(m.name.length > 3, `nombre raro: ${m.name}`);
    assert.match(m.nationality ?? '', /^[A-Z]{2,3}$/);
  }
  assert.notEqual(d.members[0].name, d.members[1].name);
  assert.ok(d.validation.ok);
});

test('parseDetail acepta la variante con etiqueta "Athlete"', () => {
  // Unas páginas traen "Name" + "Nat"; otras un único "Athlete" con la
  // nacionalidad entre paréntesis. Esta segunda devolvía name: null.
  const d = parseDetail(fx('detail-solo-athlete-label.html'), 'LR3MS4JI4F117DOV', 'pro');

  assert.equal(d.name, 'Dearden, Jake');
  assert.equal(d.nationality, 'ENG');
  assert.equal(d.members.length, 0);
  assert.equal(d.rankGender, 98);
  assert.equal(d.rankAgeGroup, 41);
  assert.equal(d.disqualReason, null);
  assert.ok(d.validation.ok);
});

test('un nombre ilegible invalida el parseo', () => {
  // Si cambian la etiqueta otra vez, debe fallar ruidosamente, no devolver null.
  const roto = fx('detail-solo.html').replace(/>Name</g, '>Nombre<');
  const d = parseDetail(roto, 'X', 'pro');
  assert.equal(d.name, null);
  assert.equal(d.validation.ok, false);
});

test('parseSearch separa la nacionalidad pegada al nombre', () => {
  // Algunas filas traen "Weeks, Lauren (USA)" en vez de nombre y bandera aparte.
  const hits = parseSearch(fx('search-name-with-nationality.html'), 'pro');
  assert.ok(hits.length > 0);

  for (const h of hits) {
    assert.ok(!h.name.includes('('), `nacionalidad sin separar: ${h.name}`);
    assert.match(h.nationality ?? '', /^[A-Z]{2,3}$/);
  }
  assert.equal(hits[0].name, 'Weeks, Lauren');
  assert.equal(hits[0].nationality, 'USA');
});

test('parseSearch lee las filas de dobles (type-relay_member)', () => {
  // La lista por evento nombra la fila con type-relay_member en vez de
  // type-fullname: con el selector antiguo devolvía 0 equipos.
  const hits = parseSearch(fx('search-doubles-in-event.html'), 'doubles');

  assert.ok(hits.length > 0, 'no encontró ningún equipo');
  const h = hits[0];
  assert.match(h.name, /,/);                        // "Nombre1, Nombre2"
  assert.ok(h.name.toLowerCase().includes('lee'));  // la búsqueda filtró
  assert.match(h.idp, /^[A-Za-z0-9]+$/);
  assert.ok(h.totalSec && h.totalSec > 1800);
  assert.match(h.ageGroup ?? '', /^\d{2}-\d{2}$|^\d{2}\+$/);
});

test('parseDetail (dobles por evento) ignora la tabla de horas de reloj', () => {
  // Esta plantilla trae una tabla extra "Split | Time Of Day | Time | Diff"
  // con horas de reloj (Rox In 08:04:15). Colaban como splits: salían 49.
  const d = parseDetail(fx('detail-doubles-in-event.html'), 'LR3MS4JI5658BD', 'doubles');

  assert.equal(d.validation.splitCount, 20, 'debe haber 19 splits + el total');
  assert.ok(d.validation.ok);
  assert.ok(!d.splits.some((s) => s.seconds > 7 * 3600), 'se coló una hora de reloj');

  // El total no está en la tabla de splits, sino como "Overall Time".
  assert.equal(d.splits.find((s) => s.key === 'total')?.time, '00:57:59');

  // La sede viene como "Race: 2026 Bangkok", con el año delante.
  assert.equal(d.city, 'Bangkok');
  assert.equal(d.year, 2026);

  assert.equal(d.members.length, 2);
  assert.equal(d.name, 'Lee, JooYeong / Jang, GyuChang');
  assert.equal(d.rankAgeGroup, 1);
});

test('dedupeNameParts colapsa miembros repetidos del origen', () => {
  // Hay eventos cuyo HTML trae cada miembro dos veces dentro del mismo <a>.
  assert.equal(
    dedupeNameParts('Lee Perfect, Lee Perfect, Rory Crighton, Rory Crighton'),
    'Lee Perfect, Rory Crighton',
  );
  // Un equipo normal no se toca, ni aunque compartan apellido.
  assert.equal(
    dedupeNameParts('Ben Sutherland, Harry Sutherland'),
    'Ben Sutherland, Harry Sutherland',
  );
  // "Apellido, Nombre" de individual tampoco: son dos segmentos distintos.
  assert.equal(dedupeNameParts('Weeks, Lauren'), 'Weeks, Lauren');
});

// Elite 15 tal cual lo sirve la web (recortado): sin fixtures, para que corra siempre.
// Tiempos con centésimas, puesto por sexo y una columna "Workout" antes del total.
const eliteListRow = (rank: number, idp: string, name: string, time: string) => `
  <li class=" list-group-item row">
    <div class="col-xs-12 col-sm-12 col-md-5 list-field-wrap"><div class="row">
      <div class=" list-field type-place place-primary numeric">${rank}</div>
      <div class=" list-field type-nation_flag place-primary"><span class="nation__labelled-icon">
        <img class="nation__icon" alt="USA" title="USA"> <span class="nation__abbr">USA</span></span></div>
      <h4 class=" list-field type-fullname"><a href="https://results.hyrox.com/season-8/?content=detail&amp;fpid=list&amp;pid=list&amp;idp=${idp}&amp;lang=EN_CAP&amp;event=HE_X">${name} (USA)</a></h4>
    </div></div>
    <div class="col-xs-12 col-sm-12 col-md-7 list-field-wrap"><div class="pull-right"><div class="row">
      <div class="rounds list-field type-eval"><div class="visible-xs-block visible-sm-block list-label">Workout</div>${time}</div>
      <div class=" list-field type-actual_ranking_time"><div class="visible-xs-block visible-sm-block list-label">Time</div><span class="text-muted">–</span></div>
      <div class="right list-field type-time time-ms"><div class="visible-xs-block visible-sm-block list-label">Totals</div>${time}</div>
    </div></div></div>
  </li>`;

test('parseListRows (Elite 15) lee los totales con centésimas', () => {
  const header = `<li class="right list-group row list-group-item list-group-header">
    <div class=" list-field type-place field-place_all place-primary">Rank</div>
    <div class="right list-field type-time field-time_finish_netto time-ms"><div class="list-label">Totals</div>Totals</div></li>`;
  const rows = parseListRows(`<ul>${header}${eliteListRow(1, 'E1', 'Scott, Dylan', '53:47.18')}${eliteListRow(1, 'E2', 'McElheny, Alyssa', '56:59.49')}</ul>`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.idp, r.rank, r.name, r.nationality, r.totalSec]), [
    ['E1', 1, 'Scott, Dylan', 'USA', 3227],
    ['E2', 1, 'McElheny, Alyssa', 'USA', 3419],
  ]);
});

test('parseDetail (Elite 15) valida sin Roxzone ni Run Total', () => {
  const labels = ['Running 1', '1000m SkiErg', 'Running 2', '50m Sled Push', 'Running 3', '50m Sled Pull',
    'Running 4', '80m Burpee Broad Jump', 'Running 5', '1000m Row', 'Running 6', '200m Farmers Carry',
    'Running 7', '100m Sandbag Lunges', 'Running 8', 'Wall Balls'];
  const splitRows = labels.map((l, i) => `<tr><th>${l}</th><td>00:0${2 + (i % 3)}:4${i % 10}</td><td>${l.startsWith('Running') ? '–' : i}</td></tr>`).join('');
  const html = `
    <table><tr><th>Athlete</th><td>Scott, Dylan (USA)</td></tr></table>
    <table><tr><th>Race</th><td>2026 Stockholm</td></tr><tr><th>Division</th><td>HYROX ELITE 15 - Thursday</td></tr></table>
    <table><tr><th>Rank (M/W)</th><td>1</td></tr><tr><th>Overall Time</th><td>53:47.18</td></tr></table>
    <table><tr><th>Split</th><th>Time</th><th>Place</th></tr>${splitRows}
      <tr><th>Run Total</th><td>–</td><td>–</td></tr><tr><th>Best Run Lap</th><td>–</td><td>–</td></tr></table>
    <table><tr><th>Split</th><th>Time Of Day</th><th>Time</th><th>Diff</th></tr>
      <tr><td>1000m SkiErg In</td><td>20:34:51</td><td>00:02:42</td><td>02:42</td></tr></table>`;
  const d = parseDetail(html, 'E1', 'pro');
  assert.ok(d.validation.ok, `validación falló: ${JSON.stringify(d.validation)}`);
  assert.equal(d.name, 'Scott, Dylan');
  assert.equal(d.rankGender, 1);
  assert.equal(d.splits.length, 17, '8 runs + 8 estaciones + total');
  assert.equal(d.splits.find((s) => s.key === 'total')?.seconds, 3227);
  assert.equal(d.splits.find((s) => s.key === 'roxzone'), undefined);
});
