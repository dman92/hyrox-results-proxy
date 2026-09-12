import type { VercelRequest, VercelResponse } from '@vercel/node';
import { detail, DIVISIONS, type Division } from '../lib/hyrox.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const idp = String(req.query.idp ?? '').trim();
  const division = String(req.query.division ?? 'open') as Division;

  if (!/^[A-Za-z0-9]{6,}$/.test(idp)) return res.status(400).json({ error: 'idp inválido' });
  if (!(division in DIVISIONS)) return res.status(400).json({ error: 'division inválida' });

  try {
    const race = await detail(idp, division);

    if (!race.validation.ok) {
      // No devolvemos datos a medias: mejor fallar ruidosamente que importar basura.
      return res.status(502).json({
        error: 'parse_failed',
        detail: 'El HTML de origen no cuadra: probablemente cambió la estructura.',
        validation: race.validation,
      });
    }

    // Un resultado pasado nunca cambia: cachea un año.
    res.setHeader('Cache-Control', 'public, s-maxage=31536000, stale-while-revalidate=86400, immutable');
    return res.status(200).json(race);
  } catch (err) {
    return res.status(502).json({ error: 'upstream', detail: String((err as Error).message) });
  }
}
