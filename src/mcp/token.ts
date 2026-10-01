import { timingSafeEqual } from 'node:crypto';

/**
 * Vergelijk een geleverd token met het verwachte in constante tijd (SPEC §7).
 * Buffers van ongelijke lengte zouden `timingSafeEqual` doen gooien; dat
 * vangen we af door altijd `false` terug te geven. Zo lekt de lengte van het
 * verwachte token niet uit via een exception.
 */
export function vergelijkMcpToken(
  geleverd: string | undefined | null,
  verwacht: string,
): boolean {
  if (!geleverd) return false;
  const g = Buffer.from(geleverd, 'utf8');
  const v = Buffer.from(verwacht, 'utf8');
  if (g.length !== v.length) return false;
  return timingSafeEqual(g, v);
}

/**
 * Leest een bearer-token uit een `Authorization`-header. Alles anders dan
 * `Bearer <token>` geeft `undefined` terug zodat de aanroeper weigert.
 */
export function tokenUitAuthorization(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const [schema, ...rest] = header.trim().split(/\s+/);
  if (!schema || schema.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}
