import type { VercelRequest, VercelResponse } from '@vercel/node';
import { UI_HTML } from '../lib/ui.js';

/** Página de pruebas de la API. vercel.json la sirve en "/". */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300');
  return res.status(200).send(UI_HTML);
}
