/**
 * De filas de resultados a personas.
 *
 * En dobles y relevos cada fila de la web es el equipo, con los integrantes separados
 * por coma y cada uno como "Nombre Apellido" ("David Manso, Lucía Pérez"); el orden,
 * las mayúsculas y los acentos cambian de una carrera a otra. En individual la fila es
 * una persona en formato "Apellido, Nombre" ("Dearden, Jake").
 *
 * Sin dependencias: lo usan la API y los tests.
 */

export interface HitLike {
  name: string;
  division: string | null;
  eventLabel?: string | null;
  totalSec?: number | null;
}

export interface AthleteResult<H> {
  /** El resultado tal cual (mismo formato que los hits de /api/search). */
  hit: H;
  /** Cómo aparece esta persona en esa carrera. */
  as: string;
  /** Compañeros de equipo (vacío en individual). */
  partners: string[];
}

export interface AthleteGroup<H> {
  /** Clave estable del grupo: palabras del nombre normalizadas y ordenadas. */
  key: string;
  /** El nombre más completo con el que aparece. */
  name: string;
  /** Todas las formas en que aparece ("David Manso", "David Manso Garcia"). */
  variants: string[];
  results: AthleteResult<H>[];
}

function tokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** "MANSO garcía" -> "Manso García" (las filas mezclan mayúsculas). */
function tidy(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export function isTeam(hit: HitLike): boolean {
  if (hit.division && /doubles|relay/.test(hit.division)) return true;
  return /doubles|relay|team/i.test(hit.eventLabel ?? '');
}

/** Integrantes de una fila, cada uno como "Nombre Apellido". */
export function members(hit: HitLike): string[] {
  const name = hit.name.trim();
  if (!isTeam(hit)) {
    // "Apellido, Nombre" -> "Nombre Apellido"
    const parts = name.split(',').map((p) => p.trim()).filter(Boolean);
    return [tidy(parts.length === 2 ? `${parts[1]} ${parts[0]}` : name)];
  }
  // Algunas fuentes separan con " / " y ponen cada miembro como "Apellido, Nombre"
  if (name.includes(' / ')) {
    return name.split(' / ').map((m) => {
      const [last, first] = m.split(',').map((p) => p.trim());
      return tidy(first ? `${first} ${last}` : m);
    });
  }
  const seen = new Set<string>();
  return name
    .split(',')
    .map((m) => tidy(m))
    .filter((m) => {
      const k = tokens(m).join(' ');
      if (!k || seen.has(k)) return false; // hay eventos que repiten cada miembro
      seen.add(k);
      return true;
    });
}

/** Todas las palabras buscadas son el comienzo de alguna palabra de ESTA persona. */
export function matchesPerson(query: string[], person: string): boolean {
  const words = tokens(person);
  return query.every((q) => words.some((w) => w.startsWith(q)));
}

/**
 * Agrupa por persona los resultados en los que alguien encaja con la búsqueda.
 * Descarta las filas donde las palabras solo encajan repartidas entre dos
 * integrantes ("david" en uno y "manso" en "Mansouri" del otro).
 *
 * Dos formas se consideran la misma persona si las palabras de una están todas en la
 * otra ("David Manso" ⊂ "David Manso Garcia"). Sin un ID de atleta en la web, es la
 * mejor aproximación: dos homónimos exactos saldrán juntos.
 */
export function groupAthletes<H extends HitLike>(q: string, hits: H[]): AthleteGroup<H>[] {
  const query = tokens(q);
  if (query.length === 0) return [];

  type Entry = { words: Set<string>; forms: Map<string, number>; results: AthleteResult<H>[] };
  const entries: Entry[] = [];

  for (const hit of hits) {
    const people = members(hit);
    for (const person of people) {
      if (!matchesPerson(query, person)) continue;
      const words = new Set(tokens(person));
      const partners = people.filter((p) => p !== person);
      // Busca un grupo compatible (una forma contiene a la otra)
      let entry = entries.find((e) => isSubset(words, e.words) || isSubset(e.words, words));
      if (!entry) {
        entry = { words, forms: new Map(), results: [] };
        entries.push(entry);
      } else if (words.size > entry.words.size) {
        entry.words = words;
      }
      entry.forms.set(person, (entry.forms.get(person) ?? 0) + 1);
      entry.results.push({ hit, as: person, partners });
    }
  }

  // Un grupo puede quedar contenido en otro que creció después: se funden
  for (let i = entries.length - 1; i >= 0; i--) {
    const j = entries.findIndex((e, k) => k !== i && (isSubset(entries[i].words, e.words) || isSubset(e.words, entries[i].words)));
    if (j >= 0) {
      const [a, b] = [entries[j], entries[i]];
      if (b.words.size > a.words.size) a.words = b.words;
      for (const [f, n] of b.forms) a.forms.set(f, (a.forms.get(f) ?? 0) + n);
      a.results.push(...b.results);
      entries.splice(i, 1);
    }
  }

  const exact = (e: Entry) => [...e.forms.keys()].some((f) => tokens(f).sort().join(' ') === [...query].sort().join(' '));
  return entries
    .map((e) => {
      const variants = [...e.forms.keys()].sort((a, b) => tokens(b).length - tokens(a).length || (e.forms.get(b)! - e.forms.get(a)!));
      return {
        entry: e,
        group: {
          key: [...e.words].sort().join(' '),
          name: variants[0],
          variants,
          results: e.results,
        },
      };
    })
    .sort((a, b) => Number(exact(b.entry)) - Number(exact(a.entry)) || b.group.results.length - a.group.results.length)
    .map((x) => x.group);
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export interface PeopleSearch<H> {
  /** Filas donde alguien encaja con la búsqueda (sin falsos positivos entre miembros). */
  hits: H[];
  /** Una entrada por persona con sus carreras, para "elige tu nombre -> tus carreras". */
  athletes: {
    key: string;
    name: string;
    variants: string[];
    count: number;
    results: (H & { as: string; partners: string[] })[];
  }[];
}

/** Máximo de filas candidatas que se revisan por búsqueda. */
export const MAX_CANDIDATES = 3000;

/**
 * Búsqueda por persona sobre una búsqueda por filas. `fetchRows(n)` devuelve hasta n
 * filas candidatas: la base de datos filtra por palabras en todo el nombre del equipo,
 * así que parte pueden ser descartes. Si los descartes dejan hueco y quedan más filas,
 * se piden más (x4 cada vez, hasta MAX_CANDIDATES).
 */
export async function searchPeople<H extends HitLike>(
  fetchRows: (n: number) => Promise<H[]>,
  q: string,
  limit: number,
): Promise<PeopleSearch<H>> {
  let n = Math.min(limit * 4, MAX_CANDIDATES);
  let candidates: H[];
  let groups: AthleteGroup<H>[];
  let matched: Set<H>;
  for (;;) {
    candidates = await fetchRows(n);
    groups = groupAthletes(q, candidates);
    matched = new Set(groups.flatMap((g) => g.results.map((r) => r.hit)));
    const exhausted = candidates.length < n;
    if (matched.size >= limit || exhausted || n >= MAX_CANDIDATES) break;
    n = Math.min(n * 4, MAX_CANDIDATES);
  }
  return {
    hits: candidates.filter((h) => matched.has(h)).slice(0, limit),
    athletes: groups.map((g) => ({
      key: g.key,
      name: g.name,
      variants: g.variants,
      count: g.results.length,
      results: g.results.map((r) => ({ ...r.hit, as: r.as, partners: r.partners })),
    })),
  };
}
