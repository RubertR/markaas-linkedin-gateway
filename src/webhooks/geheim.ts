import { timingSafeEqual } from 'node:crypto';

/**
 * Vergelijkt een geleverd geheim met het verwachte in constante tijd.
 * Retourneert altijd false bij undefined/null/leeg of ongelijke lengte —
 * timingSafeEqual gooit anders bij ongelijke lengte.
 */
export function vergelijkGeheim(
  geleverd: string | undefined | null,
  verwacht: string,
): boolean {
  if (!geleverd) return false;
  const g = Buffer.from(geleverd, 'utf8');
  const v = Buffer.from(verwacht, 'utf8');
  if (g.length !== v.length) return false;
  return timingSafeEqual(g, v);
}

export const WEBHOOK_SECRET_HEADER = 'x-webhook-secret';
