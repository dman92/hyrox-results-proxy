import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAthletes, matchesPerson, members } from '../lib/athletes.ts';

// Misma forma que una respuesta real de /api/search?q=david%20manso (nombres de terceros cambiados)
const hit = (name: string, division: string | null, eventLabel: string, totalSec: number, idp: string) =>
  ({ idp, name, division, eventLabel, totalSec });
const HITS = [
  hit('Lucía Pérez García, David Manso Garcia', 'doubles', 'HYROX DOUBLES - Saturday', 4648, 'A'),
  hit('David Manso, Lucia Perez', 'doubles', 'HYROX DOUBLES - Saturday', 4717, 'B'),
  hit('Lucia Perez, David Manso', 'doubles', 'HYROX DOUBLES - Saturday', 5264, 'C'),
  hit('Karim MANSOURI, DAVID MARTIN', 'doubles', 'HYROX DOUBLES - Saturday', 4077, 'D'),
  hit('David Martin, Karim Mansouri', 'pro_doubles', 'HYROX PRO DOUBLES', 4380, 'E'),
  hit('Karim Mansouri, David Martin', 'pro_doubles', 'HYROX PRO DOUBLES - Thursday', 4425, 'F'),
];

test('members separa equipos y reordena individuales', () => {
  assert.deepEqual(members(HITS[0]), ['Lucía Pérez García', 'David Manso Garcia']);
  assert.deepEqual(members(HITS[3]), ['Karim Mansouri', 'David Martin']);
  assert.deepEqual(members({ name: 'Dearden, Jake', division: 'pro' }), ['Jake Dearden']);
  assert.deepEqual(members({ name: 'Lee Perfect, Lee Perfect, Rory Crighton, Rory Crighton', division: 'doubles' }),
    ['Lee Perfect', 'Rory Crighton']);
  assert.deepEqual(members({ name: 'Manso, David / Perez, Lucia', division: 'doubles' }), ['David Manso', 'Lucia Perez']);
  // División desconocida (prefijo raro) pero etiqueta de dobles
  assert.deepEqual(members({ name: 'Ana Ruiz, Eva Gil', division: null, eventLabel: 'HYROX DOUBLES - Adaptive' }),
    ['Ana Ruiz', 'Eva Gil']);
});

test('matchesPerson exige que todas las palabras encajen en la misma persona', () => {
  assert.ok(matchesPerson(['david', 'manso'], 'David Manso Garcia'));
  assert.ok(matchesPerson(['manso', 'dav'], 'David Manso'));
  assert.ok(!matchesPerson(['david', 'manso'], 'David Martin'));
  assert.ok(!matchesPerson(['david', 'manso'], 'Karim Mansouri'));
});

test('groupAthletes: "david manso" -> una persona con sus 3 carreras', () => {
  const groups = groupAthletes('david manso', HITS);
  assert.equal(groups.length, 1, JSON.stringify(groups.map((g) => g.name)));
  const [me] = groups;
  assert.equal(me.name, 'David Manso Garcia');
  assert.deepEqual(me.variants.sort(), ['David Manso', 'David Manso Garcia']);
  assert.deepEqual(me.results.map((r) => r.hit.idp).sort(), ['A', 'B', 'C']);
  assert.deepEqual(me.results.find((r) => r.hit.idp === 'B')!.partners, ['Lucia Perez']);
  assert.equal(me.results.find((r) => r.hit.idp === 'A')!.as, 'David Manso Garcia');
});

test('groupAthletes: búsquedas más amplias separan personas', () => {
  const groups = groupAthletes('david', HITS);
  assert.deepEqual(groups.map((g) => [g.name, g.results.length]), [['David Manso Garcia', 3], ['David Martin', 3]]);
  // "manso" encaja en Manso y en Mansouri (prefijo): dos personas distintas
  assert.deepEqual(groupAthletes('manso', HITS).map((g) => g.name).sort(), ['David Manso Garcia', 'Karim Mansouri']);
  // La compañera también se encuentra por su nombre
  assert.deepEqual(groupAthletes('lucia perez', HITS).map((g) => [g.name, g.results.length]), [['Lucía Pérez García', 3]]);
  assert.deepEqual(groupAthletes('', HITS), []);
});

test('groupAthletes: coincidencia exacta primero', () => {
  const hits = [
    hit('Ana Gil Soto, Eva Ruiz', 'doubles', 'HYROX DOUBLES', 4000, 'X'),
    hit('Ana Gil Soto, Eva Ruiz', 'doubles', 'HYROX DOUBLES', 4001, 'Y'),
    hit('Gil, Ana', 'open', 'HYROX', 3900, 'Z'),
    hit('Gil, Anabel', 'open', 'HYROX', 3950, 'W'),
  ];
  // "Ana Gil" ⊂ "Ana Gil Soto": misma persona; "Anabel Gil" es otra
  const groups = groupAthletes('ana gil', hits);
  assert.deepEqual(groups.map((g) => [g.name, g.results.length]), [['Ana Gil Soto', 3], ['Anabel Gil', 1]]);
});

test('searchPeople pide más filas si los descartes dejan hueco', async () => {
  const { searchPeople } = await import('../lib/athletes.ts');
  const rows = [
    ...Array.from({ length: 50 }, (_, i) => hit(`Karim Mansouri${i}, David Martin`, 'doubles', 'HYROX DOUBLES', 4000 + i, 'F' + i)),
    ...HITS.slice(0, 3),
  ];
  const asked: number[] = [];
  const res = await searchPeople(async (n) => { asked.push(n); return rows.slice(0, n); }, 'david manso', 5);
  assert.deepEqual(res.hits.map((h) => h.idp).sort(), ['A', 'B', 'C']);
  assert.deepEqual(asked, [20, 80]); // 20 no bastaban; con 80 se acaban las filas
  assert.equal(res.athletes[0].count, 3);
});

test('groupAthletes: una forma corta que cabe en dos personas se queda aparte, y no depende del orden', () => {
  const hits = [
    hit('Alba Gómez García, David Manso Garcia', 'doubles', 'HYROX DOUBLES', 4648, 'A'),
    hit('David Manso, Alba Gomez', 'doubles', 'HYROX DOUBLES', 4717, 'B'),
    hit('Alba Gomez, David Manso', 'doubles', 'HYROX DOUBLES', 5264, 'C'),
    hit('Alba Gomez Lopez, Eva Ruiz', 'doubles', 'HYROX DOUBLES', 5000, 'D'),
    hit('Alba Gomez Lopez, Eva Ruiz', 'doubles', 'HYROX DOUBLES', 5100, 'E'),
  ];
  const summary = (hs: typeof hits) => groupAthletes('alba gomez', hs).map((g) => [g.name, g.results.map((r) => r.hit.idp).sort().join('')]);
  const expected = [['Alba Gomez', 'BC'], ['Alba Gomez Lopez', 'DE'], ['Alba Gómez García', 'A']];
  assert.deepEqual(summary(hits), expected);
  assert.deepEqual(summary([...hits].reverse()), expected);
  // Sin la otra Alba ya es inequívoco
  assert.deepEqual(summary(hits.slice(0, 3)), [['Alba Gómez García', 'ABC']]);
  // Y David sigue siendo uno con sus 3 carreras en cualquier orden
  assert.deepEqual(groupAthletes('david manso', [...hits].reverse()).map((g) => [g.name, g.results.length]), [['David Manso Garcia', 3]]);
});
