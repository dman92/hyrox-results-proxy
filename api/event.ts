import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ensureSchema, eventResults, getDb } from '../lib/db.js';

/**
 * GET /api/event?code=HPRO_LR3MS4JIAA2[&q=nombre][&limit=50][&offset=0]
 * Clasificación de un evento (una división de una carrera). Cada resultado tiene el
 * mismo formato que los hits de /api/search, así que se abre igual con /api/athlete.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Sin base de datos (DATABASE_URL)' });

  const code = String(req.query.code ?? '');
  if (!/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(code)) {
    return res.status(400).json({ error: 'code inválido (formato: HPRO_LR3MS4JIAA2)' });
  }
  const q = req.query.q ? String(req.query.q) : undefined;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    await ensureSchema(db);
    const { event, total, results } = await eventResults(db, code, { q, limit, offset });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ event, total, limit, offset, results });
  } catch (err) {
    return res.status(500).json({ error: 'db', detail: String((err as Error).message) });
  }
}
