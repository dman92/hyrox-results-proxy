import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearch, parseDetail, hmsToSec, canonicalKey } from '../lib/hyrox.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('hmsToSec', () => {
  assert.equal(hmsToSec('00:59:17'), 3557);
  assert.equal(hmsToSec('04:16'), 256);
  assert.equal(hmsToSec('basura'), null);
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
