import { Hono } from 'hono';

import { maakAdminApp } from '../admin/server.ts';
import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Env } from '../config/env.ts';
import type { Backend } from '../db/backend.ts';
import type { Logger } from '../log/logger.ts';
import { maakMcpApp } from '../mcp/server.ts';
import type { PauzeKiezer } from '../queue/pauze.ts';
import type { WerkdagenKiezer } from '../sequences/wachttijd.ts';
import type { UnipileClient } from '../unipile/client.ts';
import { koppelNotifyUrl } from '../webhooks/geheim.ts';
import { maakWebhookApp } from '../webhooks/server.ts';

import { maakHealthApp } from './health.ts';

/**
 * Stelt de complete HTTP-app samen: `/health`, `/webhooks/*`, `/mcp` en
 * `/admin/*` in één hono-server (SPEC §7, §8, §12). Puur samenstellen; het
 * luisteren op een poort gebeurt in `src/main.ts`.
 */

export interface GatewayDeps {
  env: Env;
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  klok: Klok;
  pauzeKiezer: PauzeKiezer;
  werkdagen: WerkdagenKiezer;
  logger: Logger;
  versie: string;
}

export function maakGatewayApp(deps: GatewayDeps) {
  const { env, logger } = deps;
  const productie = env.nodeEnv === 'production';
  const app = new Hono();

  // Toegangslog: methode, pad (zonder querystring), status en duur. Nooit
  // headers of body — daar zitten tokens, cookies en webhook-geheimen in.
  app.use('*', async (c, next) => {
    const start = performance.now();
    await next();
    const velden = {
      methode: c.req.method,
      pad: c.req.path,
      status: c.res.status,
      duur_ms: Math.round(performance.now() - start),
    };
    if (c.req.path === '/health') logger.debug('HTTP-verzoek', velden);
    else logger.info('HTTP-verzoek', velden);
  });

  app.onError((err, c) => {
    logger.error('Onverwachte fout in HTTP-verzoek', {
      methode: c.req.method,
      pad: c.req.path,
      fout: err,
    });
    return c.text('Interne fout in de gateway; zie de logs voor details.', 500);
  });

  app.route('/', maakHealthApp({ db: deps.db, versie: deps.versie }));

  app.route(
    '/',
    maakWebhookApp({
      db: deps.db,
      unipile: deps.unipile,
      webhookSecret: env.webhookSecret,
      koppelOpties: {
        notifyUrl: koppelNotifyUrl(env.publicBaseUrl, env.webhookSecret),
        apiUrl: unipileBaseUrl(env.unipileDsn),
      },
      sequentieHook: {
        db: deps.db,
        limieten: deps.limieten,
        klok: deps.klok,
        werkdagen: deps.werkdagen,
      },
    }),
  );

  app.route(
    '/',
    maakMcpApp({
      db: deps.db,
      unipile: deps.unipile,
      limieten: deps.limieten,
      klok: deps.klok,
      pauzeKiezer: deps.pauzeKiezer,
      mcpToken: env.mcpToken,
    }),
  );

  app.route(
    '/',
    maakAdminApp({
      db: deps.db,
      limieten: deps.limieten,
      klok: deps.klok,
      wachtwoordHash: env.adminPasswordHash,
      cookieSecure: productie,
      vertrouwProxy: productie,
    }),
  );

  app.get('/', (c) => c.redirect('/admin/login', 303));
  app.notFound((c) => c.text('Niet gevonden.', 404));

  return app;
}

/** `api68.unipile.com:19841` → `https://api68.unipile.com:19841`. */
export function unipileBaseUrl(dsn: string): string {
  const schoon = dsn.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(schoon) ? schoon : `https://${schoon}`;
}
