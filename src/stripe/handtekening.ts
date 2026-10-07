import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Klok } from '../budget/klok.ts';

/**
 * Controle van de `Stripe-Signature`-header op webhooks (SPEC §14.4), volgens
 * het schema dat Stripe documenteert:
 *
 *   Stripe-Signature: t=1700000000,v1=<hex>,v1=<hex>,v0=<hex>
 *
 * - `t` is het tijdstip van ondertekenen (Unix-seconden);
 * - elke `v1` is HMAC-SHA256 over `${t}.${ruweBody}` met STRIPE_WEBHOOK_SECRET
 *   (tijdens het roteren van het geheim kunnen er meerdere zijn);
 * - andere schema's (zoals `v0`) worden genegeerd.
 *
 * Altijd de ruwe body gebruiken zoals ontvangen (niet opnieuw serialiseren),
 * constant-time vergelijken, en een tijdstempel ouder (of nieuwer) dan de
 * tolerantie weigeren tegen het opnieuw afspelen van oude berichten.
 */

export const STRIPE_HANDTEKENING_HEADER = 'stripe-signature';
export const STANDAARD_TOLERANTIE_SECONDEN = 300;

export class StripeHandtekeningFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'StripeHandtekeningFout';
  }
}

export interface HandtekeningInvoer {
  header: string | undefined | null;
  ruweBody: string;
  geheim: string;
  klok: Klok;
  tolerantieSeconden?: number;
}

export function verifieerStripeHandtekening(invoer: HandtekeningInvoer): void {
  if (!invoer.header) {
    throw new StripeHandtekeningFout('Stripe-Signature-header ontbreekt; webhook genegeerd.');
  }
  let t: number | null = null;
  const handtekeningen: string[] = [];
  for (const deel of invoer.header.split(',')) {
    const idx = deel.indexOf('=');
    if (idx <= 0) continue;
    const sleutel = deel.slice(0, idx).trim();
    const waarde = deel.slice(idx + 1).trim();
    if (sleutel === 't' && /^\d+$/.test(waarde)) t = Number(waarde);
    else if (sleutel === 'v1' && waarde) handtekeningen.push(waarde);
  }
  if (t === null) {
    throw new StripeHandtekeningFout('Stripe-Signature-header bevat geen geldig tijdstip (t=); webhook genegeerd.');
  }
  if (handtekeningen.length === 0) {
    throw new StripeHandtekeningFout('Stripe-Signature-header bevat geen v1-handtekening; webhook genegeerd.');
  }

  const verwacht = Buffer.from(berekenHandtekening(t, invoer.ruweBody, invoer.geheim), 'utf8');
  const klopt = handtekeningen.some((h) => {
    const b = Buffer.from(h, 'utf8');
    return b.length === verwacht.length && timingSafeEqual(b, verwacht);
  });
  if (!klopt) {
    throw new StripeHandtekeningFout(
      'Stripe-handtekening klopt niet; controleer STRIPE_WEBHOOK_SECRET (het geheim van dit webhook-endpoint in Stripe).',
    );
  }

  const tolerantie = invoer.tolerantieSeconden ?? STANDAARD_TOLERANTIE_SECONDEN;
  const nu = Math.floor(invoer.klok.nu().getTime() / 1000);
  if (Math.abs(nu - t) > tolerantie) {
    throw new StripeHandtekeningFout(
      `Tijdstip van de Stripe-handtekening wijkt meer dan ${tolerantie} seconden af; mogelijk een opnieuw afgespeeld bericht. Webhook genegeerd.`,
    );
  }
}

/** HMAC-SHA256 (hex) over `${t}.${ruweBody}`. */
export function berekenHandtekening(t: number, ruweBody: string, geheim: string): string {
  return createHmac('sha256', geheim).update(`${t}.${ruweBody}`, 'utf8').digest('hex');
}
