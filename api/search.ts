import type { VercelRequest, VercelResponse } from '@vercel/node';
import { search, searchInEvent, DIVISIONS, type Division, UpstreamTimeout } from '../lib/hyrox.js';
import { getDb, searchDb } from '../lib/db.js';
import { searchPeople } from '../lib/athletes.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // `q` acepta nombre y apellidos en cualquier orden; `surname` se mantiene por compatibilidad.
  const surname = String(req.query.q ?? req.query.surname ?? '').trim();
  const divisionParam = req.query.division ? String(req.query.division) : undefined;
  const division = (divisionParam ?? 'open') as Division;
  const eventId = req.query.eventId ? String(req.query.eventId) : undefined;
  const season = req.query.season ? String(req.query.season) : undefined;
  const sex = req.query.sex ? (String(req.query.sex).toUpperCase() as 'M' | 'W') : undefined;
  const ageClass = req.query.ageClass ? String(req.query.ageClass) : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);

  if (surname.length < 2) {
    return res.status(400).json({ error: 'q (o surname) requerido (mínimo 2 caracteres)' });
  }
  if (!(division in DIVISIONS)) {
    return res.status(400).json({ error: `division inválida. Válidas: ${Object.keys(DIVISIONS).join(', ')}` });
  }

  // 1) Base de datos: instantáneo y cubre todas las divisiones. Sin `division`
  //    explícita busca en todas; en dobles no hace falta eventId.
  const db = getDb();
  if (db && !eventId) {
    try {
      // Por persona: descarta filas donde las palabras solo encajan repartidas entre dos
      // miembros de un equipo, y agrupa las carreras de cada atleta en `athletes`.
      const { hits, athletes } = await searchPeople(
        (n) => searchDb(db, surname, { division: divisionParam as Division | undefined, limit: n }),
        surname,
        limit,
      );
      if (hits.length > 0) {
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
        return res.status(200).json({
          query: { q: surname, division: divisionParam ?? null }, source: 'db', count: hits.length, hits, athletes,
        });
      }
    } catch (err) {
      // Si la base de datos falla, seguimos en vivo en vez de devolver un error.
      console.error('searchDb falló:', (err as Error).message);
    }
  }

  // 2) En vivo contra results.hyrox.com (resultados aún no volcados, o sin base de datos).
  // En dobles y relevos el ranking all-time IGNORA search[name]:
  // hay que acotar por evento o no se encuentra nada.
  const needsEvent = division === 'doubles' || division === 'pro_doubles' || division === 'relay';
  if (needsEvent && !eventId) {
    return res.status(400).json({
      error: 'En dobles y relevos hace falta eventId: el ranking all-time no admite búsqueda por nombre.',
      hint: 'Pide al usuario la sede y el día, y pasa el eventId de ese evento (p. ej. LR3MS4JI1760).',
    });
  }

  try {
    const hits = eventId
      ? await searchInEvent({ surname, eventId, division, limit, season })
      : await search({ surname, division, sex, ageClass, limit });

    // Las carreras pasadas no cambian, pero pueden aparecer nuevas.
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ query: { surname, division, eventId, sex, ageClass }, source: 'live', count: hits.length, hits });
  } catch (err) {
    if (err instanceof UpstreamTimeout) {
      // La petición en frío calienta su caché: un reintento suele ir inmediato.
      res.setHeader('Retry-After', '5');
      return res.status(504).json({ error: 'upstream_timeout', retryable: true, detail: err.message });
    }
    return res.status(502).json({ error: 'upstream', detail: String((err as Error).message) });
  }
}
