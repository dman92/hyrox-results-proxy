import type { VercelRequest, VercelResponse } from '@vercel/node';
import { detail, detailUrl, DIVISIONS, splitEventCode, type Division, type RaceDetail, UpstreamTimeout } from '../lib/hyrox.js';
import { getCachedDetail, getDb, saveDetail } from '../lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const idp = String(req.query.idp ?? '').trim();
  // Hits de la base de datos: traen `event` (código completo) y `season`. Con eso basta.
  const event = req.query.event ? String(req.query.event) : null;
  if (event !== null && !/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(event)) {
    return res.status(400).json({ error: 'event inválido (formato: HPRO_LR3MS4JIAA2)' });
  }
  const fromEvent = event ? splitEventCode(event) : null;
  const division = (fromEvent?.division ?? String(req.query.division ?? 'open')) as Division;
  // Si el idp vino de una búsqueda por evento, hay que devolver ese eventId.
  const eventId = fromEvent ? fromEvent.eventId : req.query.eventId ? String(req.query.eventId) : null;
  const season = req.query.season ? String(req.query.season) : undefined;

  // Los idp de listas por evento pueden llevar sufijo con guion bajo (p. ej. LR3MS4JI458BCA_AMS)
  if (!/^[A-Za-z0-9_]{6,}$/.test(idp)) return res.status(400).json({ error: 'idp inválido' });
  if (season !== undefined && !/^season-\d{1,2}$/.test(season)) {
    return res.status(400).json({ error: 'season inválida (formato: season-8)' });
  }
  if (!(division in DIVISIONS)) return res.status(400).json({ error: 'division inválida' });

  // Prefijo de división desconocido (HD1, HA...): se pide con el código completo.
  const eventCode = event && !fromEvent?.division ? event : null;
  const url = season
    ? detailUrl(idp, division, eventId, season, eventCode)
    : detailUrl(idp, division, eventId, undefined, eventCode);

  const db = getDb();
  if (db) {
    try {
      const hit = await getCachedDetail<RaceDetail>(db, url);
      if (hit) {
        res.setHeader('Cache-Control', 'public, s-maxage=31536000, stale-while-revalidate=86400, immutable');
        return res.status(200).json(hit);
      }
    } catch (err) {
      console.error('getCachedDetail falló:', (err as Error).message);
    }
  }

  try {
    const race = season
      ? await detail(idp, division, eventId, season, eventCode)
      : await detail(idp, division, eventId, undefined, eventCode);

    if (!race.validation.ok) {
      // No devolvemos datos a medias: mejor fallar ruidosamente que importar basura.
      return res.status(502).json({
        error: 'parse_failed',
        detail: 'El HTML de origen no cuadra: probablemente cambió la estructura.',
        validation: race.validation,
      });
    }

    if (db) {
      // La próxima vez no hace falta ir a results.hyrox.com (ni esperar su arranque en frío).
      await saveDetail(db, url, race).catch((err) => console.error('saveDetail falló:', err.message));
    }

    // Un resultado pasado nunca cambia: cachea un año.
    res.setHeader('Cache-Control', 'public, s-maxage=31536000, stale-while-revalidate=86400, immutable');
    return res.status(200).json(race);
  } catch (err) {
    if (err instanceof UpstreamTimeout) {
      // La petición en frío calienta su caché: un reintento suele ir inmediato.
      res.setHeader('Retry-After', '5');
      return res.status(504).json({ error: 'upstream_timeout', retryable: true, detail: err.message });
    }
    return res.status(502).json({ error: 'upstream', detail: String((err as Error).message) });
  }
}
