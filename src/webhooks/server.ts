import { Hono } from 'hono';

import type { Backend } from '../db/backend.ts';
import { verwerkKoppelCallback, type KoppelflowOpties } from '../register/koppelflow.ts';
import type { SequentieHookDeps } from '../sequences/hooks.ts';
import type { UnipileClient } from '../unipile/client.ts';

import { WEBHOOK_SECRET_HEADER, vergelijkGeheim } from './geheim.ts';
import { verwerkUnipileWebhook } from './unipile.ts';

export interface WebhookDeps {
  db: Backend;
  unipile: UnipileClient;
  webhookSecret: string;
  koppelOpties: KoppelflowOpties;
  /** Koppelt new_relation/message_received aan de sequentie-motor (SPEC §8a). */
  sequentieHook?: SequentieHookDeps;
}

const WEIGER_TEKST = 'Webhook geweigerd: geheim ontbreekt of klopt niet.';

export function maakWebhookApp(deps: WebhookDeps) {
  const app = new Hono();

  app.use('/webhooks/*', async (c, next) => {
    const geleverd = c.req.header(WEBHOOK_SECRET_HEADER);
    if (!vergelijkGeheim(geleverd, deps.webhookSecret)) {
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
    return c.json(uitkomst, 200);
  });

  return app;
}
