import { createHmac, timingSafeEqual } from 'node:crypto';

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

/** Queryparameter met de koppelsleutel in de notify_url van hosted auth. */
export const KOPPEL_SLEUTEL_PARAM = 'k';

/**
 * Sleutel voor `/webhooks/koppel`: HMAC-SHA256 over de vaste tekst "koppel"
 * met WEBHOOK_SECRET als sleutel (hex). Unipile hosted auth kan bij de
 * notify_url geen eigen headers meesturen, dus deze sleutel gaat mee in de
 * URL. Afgeleid, zodat het geheim zelf nooit in een URL terechtkomt.
 */
export function koppelSleutel(webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update('koppel').digest('hex');
}

/**
 * Volledige notify_url voor koppellinks, inclusief sleutel. Bevat een
 * geheim: nooit loggen of tonen.
 */
export function koppelNotifyUrl(publicBaseUrl: string, webhookSecret: string): string {
  return `${publicBaseUrl}/webhooks/koppel?${KOPPEL_SLEUTEL_PARAM}=${koppelSleutel(webhookSecret)}`;
}

export interface KoppelpaginaSleutels {
  /** HMAC-sleutel voor `account_consents.ip_hash` (SPEC §14.2 punt 4, "geheim zout"). */
  ipSleutel: string;
  /** HMAC-sleutel voor het CSRF-veld op `/koppelen/<token>`. */
  csrfSleutel: string;
}

/**
 * Sleutels voor de publieke koppelpagina, afgeleid van WEBHOOK_SECRET op
 * dezelfde manier als `koppelSleutel`, elk met een eigen vaste tekst. Zo is er
 * geen extra omgevingsvariabele nodig en lekt het geheim zelf nergens heen.
 * Let op: wie WEBHOOK_SECRET vervangt, maakt bestaande ip-hashes onvergelijkbaar.
 */
export function koppelpaginaSleutels(webhookSecret: string): KoppelpaginaSleutels {
  return {
    ipSleutel: createHmac('sha256', webhookSecret).update('consent-ip').digest('hex'),
    csrfSleutel: createHmac('sha256', webhookSecret).update('koppelen-csrf').digest('hex'),
  };
}
