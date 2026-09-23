import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Qué build está sirviendo ahora mismo. Sin esto, la única forma de saber si un
 * despliegue había entrado era deducirlo del comportamiento de los endpoints.
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    status: 'ok',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split('\n')[0] ?? null,
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    region: process.env.VERCEL_REGION ?? null,
    node: process.version,
  });
}
