import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Bepaalt het IP-adres van de bezoeker. Gedeeld door de goedkeuringspagina
 * (brute-force-blokkade) en de koppelpagina (gehashte IP in de toestemming).
 *
 * Met `vertrouwProxy` (productie op Railway): het laatste item van
 * `X-Forwarded-For` — Railway's edge-proxy voegt het echte client-IP achteraan
 * toe; eerdere items kan de client zelf meesturen — en anders `X-Real-IP`.
 * Zonder: het adres van de Node-socket. Geeft `null` als niets bekend is.
 */
export function clientIp(c: Context, vertrouwProxy: boolean): string | null {
  if (vertrouwProxy) {
    const doorgestuurd = c.req
      .header('x-forwarded-for')
      ?.split(',')
      .map((d) => d.trim())
      .filter((d) => d !== '');
    const laatste = doorgestuurd?.[doorgestuurd.length - 1];
    if (laatste) return laatste;
    const echt = c.req.header('x-real-ip')?.trim();
    if (echt) return echt;
    return null;
  }
  try {
    const adres = getConnInfo(c).remote.address;
    if (adres) return adres;
  } catch {
    /* geen Node-socket (bijv. app.request in tests) */
  }
  return null;
}
