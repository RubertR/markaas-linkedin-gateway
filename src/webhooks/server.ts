import { Hono } from 'hono';

import type { Backend } from '../db/backend.ts';
import type { Logger } from '../log/logger.ts';
import { verwerkKoppelCallback, type KoppelflowOpties } from '../register/koppelflow.ts';
import type { SequentieHookDeps } from '../sequences/hooks.ts';
import type { UnipileClient } from '../unipile/client.ts';

import {
  KOPPEL_SLEUTEL_PARAM,
  WEBHOOK_SECRET_HEADER,
  koppelSleutel,
  vergelijkGeheim,
} from './geheim.ts';
import { verwerkUnipileWebhook } from './unipile.ts';

export interface WebhookDeps {
  db: Backend;
  unipile: UnipileClient;
  webhookSecret: string;
  koppelOpties: KoppelflowOpties;
  /** Koppelt new_relation/message_received aan de sequentie-motor (SPEC §8a). */
  sequentieHook?: SequentieHookDeps;
  /** Eén info-regel per webhook met event en uitkomst. */
  logger?: Logger;
}

const WEIGER_TEKST = 'Webhook geweigerd: geheim ontbreekt of klopt niet.';

export function maakWebhookApp(deps: WebhookDeps) {
  const app = new Hono();

  const sleutel = koppelSleutel(deps.webhookSecret);

  // /webhooks/koppel: header óf de afgeleide sleutel in ?k= (hosted auth kan
  // geen headers meesturen). Alle andere webhooks: alleen de header.
  app.use('/webhooks/*', async (c, next) => {
    const viaHeader = vergelijkGeheim(c.req.header(WEBHOOK_SECRET_HEADER), deps.webhookSecret);
    const viaSleutel =
      c.req.path === '/webhooks/koppel' &&
      vergelijkGeheim(c.req.query(KOPPEL_SLEUTEL_PARAM), sleutel);
    if (!viaHeader && !viaSleutel) {
      return c.text(WEIGER_TEKST, 401);
    }
    return await next();
  });

  app.post('/webhooks/unipile', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.text('Ongeldige JSON in webhook-body.', 400);
    }
    if (!payload || typeof payload !== 'object') {
      return c.text('Webhook-body moet een JSON-object zijn.', 400);
    }
    const uitkomst = await verwerkUnipileWebhook(
      deps.db,
      deps.unipile,
      deps.koppelOpties,
      payload as Record<string, unknown>,
      deps.sequentieHook,
    );
    logUitkomst('unipile', (payload as { event?: unknown }).event, uitkomst);
    return c.json(uitkomst, 200);
  });

  app.post('/webhooks/koppel', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.text('Ongeldige JSON in webhook-body.', 400);
    }
    if (!payload || typeof payload !== 'object') {
      return c.text('Webhook-body moet een JSON-object zijn.', 400);
    }
    const uitkomst = await verwerkKoppelCallback(deps.db, payload as {
      status: string;
      account_id: string;
      name?: string;
    });
    logUitkomst('koppel', (payload as { status?: unknown }).status, uitkomst);
    return c.json(uitkomst, 200);
  });

  /**
   * Eén info-regel per verwerkte webhook: route, eventnaam en uitkomst. Geen
   * payload-velden; waarden tussen aanhalingstekens in de reden (account-id's,
   * namen) worden weggelaten.
   */
  function logUitkomst(
    route: 'unipile' | 'koppel',
    event: unknown,
    uitkomst: { verwerkt: boolean; reden?: string },
  ): void {
    deps.logger?.info('Webhook ontvangen', {
      route,
      event: typeof event === 'string' ? event.slice(0, 64) : null,
      verwerkt: uitkomst.verwerkt,
      ...(uitkomst.reden ? { reden: zonderWaarden(uitkomst.reden) } : {}),
    });
  }

  return app;
}

function zonderWaarden(reden: string): string {
  return reden.replace(/"[^"]*"/g, '"…"');
}
