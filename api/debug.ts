import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as cheerio from 'cheerio';
import { detailUrl, fetchPage, splitEventCode } from '../lib/hyrox.js';

/**
 * TEMPORAL: diagnóstico del HTML de results.hyrox.com para ver dónde está la sede de
 * cada evento. Se quitará cuando esté resuelto.
 *
 *   /api/debug?season=season-8                       -> desplegables del listado
 *   /api/debug?season=season-8&group=<valor>         -> ídem, pidiendo esa sede
 *   /api/debug?season=season-8&idp=…&event=…         -> campos de una ficha de detalle
 */
const BASE = 'https://results.hyrox.com';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const season = String(req.query.season ?? 'season-8');
  if (!/^season-\d{1,2}$/.test(season)) return res.status(400).json({ error: 'season inválida' });
  const idp = req.query.idp ? String(req.query.idp) : null;
  const event = req.query.event ? String(req.query.event) : null;
  const group = req.query.group ? String(req.query.group) : null;
  if (idp && !/^[A-Za-z0-9_]{6,}$/.test(idp)) return res.status(400).json({ error: 'idp inválido' });
  if (event && !/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(event)) return res.status(400).json({ error: 'event inválido' });

  try {
    if (idp && event) {
      const { division } = splitEventCode(event);
      const url = detailUrl(idp, division ?? 'open', null, season, event);
      const $ = cheerio.load(await fetchPage(url));
      const pairs: [string, string][] = [];
      $('tr').each((_, tr) => {
        const cells = $(tr).find('th, td').map((__, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
        if (cells.length >= 2) pairs.push([cells[0], cells.slice(1).join(' | ')]);
      });
      return res.status(200).json({
        url,
        title: $('title').text().trim(),
        headings: $('h1, h2, h3, h4').map((_, h) => $(h).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).slice(0, 40),
        pairs: pairs.slice(0, 80),
        // Cualquier texto corto con un año: la sede suele ir así ("2025 Málaga")
        withYear: [...new Set($('body *').contents().filter((_, n) => n.type === 'text')
          .map((_, n) => $(n).text().replace(/\s+/g, ' ').trim()).get()
          .filter((t) => /\b20\d{2}\b/.test(t) && t.length < 80))].slice(0, 40),
      });
    }

    const qs = new URLSearchParams({ pid: 'list', lang: 'EN_CAP' });
    if (group) qs.set('event_main_group', group);
    const url = `${BASE}/${season}/?${qs}`;
    const $ = cheerio.load(await fetchPage(url));
    const selects = $('select').map((_, el) => {
      const $s = $(el);
      const options = $s.find('option').map((__, o) => ({
        value: $(o).attr('value') ?? null,
        text: $(o).text().replace(/\s+/g, ' ').trim(),
        attrs: Object.fromEntries(Object.entries((o as any).attribs ?? {}).filter(([k]) => k !== 'value')),
        optgroup: $(o).parent('optgroup').attr('label') ?? null,
      })).get();
      return {
        name: $s.attr('name') ?? null,
        id: $s.attr('id') ?? null,
        count: options.length,
        options: options.length > 30 ? [...options.slice(0, 20), ...options.slice(-5)] : options,
      };
    }).get();
    const scripts = $('script').map((_, sc) => $(sc).html() ?? '').get()
      .filter((t) => /event_main_group|lists/.test(t))
      .map((t) => t.slice(0, 3000));
    return res.status(200).json({ url, title: $('title').text().trim(), selects, scripts: scripts.slice(0, 3) });
  } catch (err) {
    return res.status(502).json({ error: String((err as Error).message) });
  }
}
