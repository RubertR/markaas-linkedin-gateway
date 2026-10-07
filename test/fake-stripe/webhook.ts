import { createHmac } from 'node:crypto';

/**
 * Maakt Stripe-webhook-events met een geldige `Stripe-Signature`-header,
 * los van de productiecode (eigen HMAC-berekening), zodat de tests de
 * verificatie in src/stripe/handtekening.ts echt toetsen.
 */

export interface StripeEventOpties {
  id?: string;
  /** event.created, Unix-seconden. Standaard het ondertekentijdstip. */
  created?: number;
}

let volgnummer = 0;

export function maakStripeEvent(
  type: string,
  object: Record<string, unknown>,
  opties: StripeEventOpties = {},
): Record<string, unknown> {
  return {
    id: opties.id ?? `evt_test_${String(++volgnummer).padStart(6, '0')}`,
    object: 'event',
    api_version: '2024-06-20',
    created: opties.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  };
}

/** Header-waarde `t=…,v1=…` voor deze ruwe body. Extra v1's voor rotatietests. */
export function ondertekenStripe(
  ruweBody: string,
  geheim: string,
  tSeconden: number,
  extraHandtekeningen: string[] = [],
): string {
  const v1 = createHmac('sha256', geheim).update(`${tSeconden}.${ruweBody}`).digest('hex');
  return [`t=${tSeconden}`, ...extraHandtekeningen.map((h) => `v1=${h}`), `v1=${v1}`, 'v0=ongebruikt'].join(',');
}

/** Body + headers voor een POST naar /webhooks/stripe. */
export function ondertekendVerzoek(
  event: Record<string, unknown>,
  geheim: string,
  tSeconden: number,
): { body: string; headers: Record<string, string> } {
  // Stripe stuurt opgemaakte JSON; een her-serialisatie zou dus niet kloppen.
  const body = JSON.stringify(event, null, 2);
  return {
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'stripe-signature': ondertekenStripe(body, geheim, tSeconden),
    },
  };
}
