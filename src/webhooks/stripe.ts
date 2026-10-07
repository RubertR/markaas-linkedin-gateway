import { Hono } from 'hono';

import { StripeEventFout, alsStripeEvent, verwerkStripeEvent } from '../abonnement/webhook.ts';
import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import type { Logger } from '../log/logger.ts';
import type { StripeClient } from '../stripe/client.ts';
import {
  STRIPE_HANDTEKENING_HEADER,
  StripeHandtekeningFout,
  verifieerStripeHandtekening,
} from '../stripe/handtekening.ts';

/**
 * `POST /webhooks/stripe` (SPEC §14.4). Eigen sub-app: NIET achter het
 * Unipile-webhookgeheim, wel achter de Stripe-handtekening.
 *
 * - Stripe uit (env-variabelen ontbreken): 503, niets opgeslagen.
 * - Ongeldige of verlopen handtekening: 400, niets opgeslagen.
 * - Geldig: event opslaan en verwerken (src/abonnement/webhook.ts), 200.
 *   Dubbele levering en onbekende events: ook 200.
 * - Fout bij verwerken (bijv. Stripe onbereikbaar bij ophalen): 500, zodat
 *   Stripe het later opnieuw probeert; er is dan niets opgeslagen.
 */

export const STRIPE_WEBHOOK_PAD = '/webhooks/stripe';

export interface StripeWebhookAppDeps {
  db: Backend;
  klok: Klok;
  /** `null` = betalen is nog niet ingericht. */
  stripe: { client: StripeClient; webhookSecret: string } | null;
  logger?: Logger;
}

export function maakStripeWebhookApp(deps: StripeWebhookAppDeps) {
  const app = new Hono();

  app.post(STRIPE_WEBHOOK_PAD, async (c) => {
    if (!deps.stripe) {
      return c.text('Betalen is nog niet ingericht (STRIPE_*-variabelen ontbreken); webhook niet verwerkt.', 503);
    }
    // Ruwe body precies zoals ontvangen: de handtekening is daarover berekend.
    const ruweBody = await c.req.text();
    try {
      verifieerStripeHandtekening({
        header: c.req.header(STRIPE_HANDTEKENING_HEADER),
        ruweBody,
        geheim: deps.stripe.webhookSecret,
        klok: deps.klok,
      });
    } catch (err) {
      if (!(err instanceof StripeHandtekeningFout)) throw err;
      deps.logger?.warn('Stripe-webhook geweigerd', { reden: err.message });
      return c.text(err.message, 400);
    }

    let event;
    try {
      event = alsStripeEvent(JSON.parse(ruweBody));
    } catch (err) {
      const reden = err instanceof StripeEventFout ? err.message : 'Ongeldige JSON in Stripe-webhook.';
      return c.text(reden, 400);
    }

    try {
      const uitkomst = await verwerkStripeEvent({ db: deps.db, stripe: deps.stripe.client, klok: deps.klok }, event);
      deps.logger?.info('Webhook ontvangen', {
        route: 'stripe',
        event: event.type.slice(0, 64),
        verwerkt: uitkomst.verwerkt,
        ...(uitkomst.reden ? { reden: uitkomst.reden } : {}),
      });
      return c.json(uitkomst, 200);
    } catch (err) {
      deps.logger?.error('Stripe-webhook verwerken mislukt; Stripe probeert het opnieuw', {
        event: event.type.slice(0, 64),
        fout: (err as Error).message,
      });
      return c.text('Verwerken mislukt; probeer later opnieuw.', 500);
    }
  });

  return app;
}
