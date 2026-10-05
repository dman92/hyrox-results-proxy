import type { VercelRequest, VercelResponse } from '@vercel/node';
import { dbStats, getDb } from '../lib/db.js';

/**
 * Qué build está sirviendo ahora mismo y, si hay base de datos, cuánto ocupa (para
 * vigilar el límite de 0,5 GB del plan gratuito de Neon) y cómo va la ingesta.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const db = getDb();
  let database: unknown = null;
  if (db) {
    try {
      database = await dbStats(db);
    } catch (err) {
      database = { error: String((err as Error).message) };
    }
  }
  return res.status(200).json({
    status: 'ok',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split('\n')[0] ?? null,
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    region: process.env.VERCEL_REGION ?? null,
    node: process.version,
    database,
  });
}
