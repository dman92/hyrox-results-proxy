import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eliteRaces, ensureSchema, getDb } from '../lib/db.js';

/**
 * GET /api/elite?limit=5 -> últimas carreras Elite 15 (individual y dobles), con
 * todos sus resultados, el sexo y el puesto dentro de cada sexo.
 * Los resultados se abren con /api/athlete igual que los de /api/search.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Sin base de datos (DATABASE_URL)' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);
  try {
    await ensureSchema(db);
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    const races = await eliteRaces(db, limit);
    return res.status(200).json({ count: races.length, races });
  } catch (err) {
    return res.status(500).json({ error: 'db', detail: String((err as Error).message) });
  }
}
