import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, listRaces, listSeasons } from '../lib/db.js';

/**
 * GET /api/events                 -> temporadas disponibles
 * GET /api/events?season=season-9 -> carreras de esa temporada con sus divisiones
 * Solo con base de datos: son los eventos que ha descubierto la ingesta.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Sin base de datos (DATABASE_URL)' });

  const season = req.query.season ? String(req.query.season) : null;
  if (season !== null && !/^season-\d{1,2}$/.test(season)) {
    return res.status(400).json({ error: 'season inválida (formato: season-8)' });
  }

  try {
    // Cambia cuando la ingesta añade carreras o resultados: caché corta.
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    if (!season) return res.status(200).json({ seasons: await listSeasons(db) });
    const races = await listRaces(db, season);
    return res.status(200).json({ season, count: races.length, races });
  } catch (err) {
    return res.status(500).json({ error: 'db', detail: String((err as Error).message) });
  }
}
