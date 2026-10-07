import { Hono } from 'hono';

import { maakAdminApp } from '../admin/server.ts';
import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Env } from '../config/env.ts';
import type { Juridisch } from '../config/juridisch.ts';
import type { Backend } from '../db/backend.ts';
import { maakKoppelApp } from '../koppelen/server.ts';
import type { Logger } from '../log/logger.ts';
import { maakMcpApp } from '../mcp/server.ts';
import { maakPortaalApp } from '../portaal/server.ts';
import type { PauzeKiezer } from '../queue/pauze.ts';
import type { WerkdagenKiezer } from '../sequences/wachttijd.ts';
import { maakStripeClient, type StripeClient } from '../stripe/client.ts';
import type { UnipileClient } from '../unipile/client.ts';
import { koppelNotifyUrl } from '../webhooks/geheim.ts';
import { maakWebhookApp } from '../webhooks/server.ts';
import { maakStripeWebhookApp } from '../webhooks/stripe.ts';

import { maakHealthApp } from './health.ts';

/**
 * Stelt de complete HTTP-app samen: `/health`, `/webhooks/*` (incl.
 * `/webhooks/stripe`, SPEC §14.4), `/mcp`,
 * `/admin/*`, de publieke koppelpagina `/koppelen/*` en het klantportaal
 * `/portaal/*` in één hono-server (SPEC §7, §8, §12, §14.2, §14.3). Puur samenstellen; het
 * luisteren op een poort gebeurt in `src/main.ts`.
 */

export interface GatewayDeps {
  env: Env;
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  juridisch: Juridisch;
  klok: Klok;
  pauzeKiezer: PauzeKiezer;
  werkdagen: WerkdagenKiezer;
  logger: Logger;
  versie: string;
  /** config/abonnement.json (SPEC §14.4). */
  abonnement: AbonnementConfig;
  /**
   * Alleen voor tests (fake-stripe). Productie: gemaakt uit `env.stripe`.
   * Zonder `env.stripe` staat Stripe altijd uit, ook als dit gezet is.
   */
  stripe?: StripeClient;
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
      pad: maskeerPad(c.req.path),
      status: c.res.status,
      duur_ms: Math.round(performance.now() - start),
    };
    if (c.req.path === '/health') logger.debug('HTTP-verzoek', velden);
    else logger.info('HTTP-verzoek', velden);
  });

  app.onError((err, c) => {
    logger.error('Onverwachte fout in HTTP-verzoek', {
      methode: c.req.method,
      pad: maskeerPad(c.req.path),
      fout: err,
    });
    return c.text('Interne fout in de gateway; zie de logs voor details.', 500);
  });

  app.route('/', maakHealthApp({ db: deps.db, versie: deps.versie }));

  // Stripe (SPEC §14.4): alleen aan als alle drie de STRIPE_*-variabelen gezet zijn.
  const stripeClient = env.stripe
    ? (deps.stripe ?? maakStripeClient({ secretKey: env.stripe.secretKey }))
    : null;

  // Vóór de Unipile-webhooks: /webhooks/stripe heeft een eigen handtekening.
  app.route(
    '/',
    maakStripeWebhookApp({
      db: deps.db,
      klok: deps.klok,
      stripe: stripeClient && env.stripe ? { client: stripeClient, webhookSecret: env.stripe.webhookSecret } : null,
      logger,
    }),
  );

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
      logger,
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
      publicBaseUrl: env.publicBaseUrl,
      koppeluitnodigingGeldigDagen: deps.juridisch.koppeluitnodiging_geldig_dagen,
      stripeIngericht: stripeClient !== null,
    }),
  );

  app.route(
    '/',
    maakKoppelApp({
      db: deps.db,
      unipile: deps.unipile,
      klok: deps.klok,
      limieten: deps.limieten,
      juridisch: deps.juridisch,
      koppelOpties: {
        notifyUrl: koppelNotifyUrl(env.publicBaseUrl, env.webhookSecret),
        apiUrl: unipileBaseUrl(env.unipileDsn),
        successRedirectUrl: `${env.publicBaseUrl}/koppelen/klaar`,
        failureRedirectUrl: `${env.publicBaseUrl}/koppelen/mislukt`,
      },
      webhookSecret: env.webhookSecret,
      vertrouwProxy: productie,
      logger,
    }),
  );

  app.route(
    '/',
    maakPortaalApp({
      db: deps.db,
      limieten: deps.limieten,
      klok: deps.klok,
      unipile: deps.unipile,
      koppelOpties: {
        notifyUrl: koppelNotifyUrl(env.publicBaseUrl, env.webhookSecret),
        apiUrl: unipileBaseUrl(env.unipileDsn),
      },
      cookieSecure: productie,
      vertrouwProxy: productie,
      koppeluitnodigingGeldigDagen: deps.juridisch.koppeluitnodiging_geldig_dagen,
      abonnement: {
        stripe: stripeClient && env.stripe ? { client: stripeClient, priceId: env.stripe.priceId } : null,
        config: deps.abonnement,
        publicBaseUrl: env.publicBaseUrl,
      },
      logger,
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

const VASTE_KOPPELPADEN = new Set(['/koppelen/klaar', '/koppelen/mislukt']);

/**
 * Het token van de koppelpagina en van de portaaluitnodiging staat in het pad;
 * dat hoort niet in de logs. `/koppelen/<token>` → `/koppelen/…`,
 * `/portaal/uitnodiging/<token>` → `/portaal/uitnodiging/…`.
 */
export function maskeerPad(pad: string): string {
  if (pad.startsWith('/portaal/uitnodiging/')) return '/portaal/uitnodiging/…';
  if (!pad.startsWith('/koppelen/') || VASTE_KOPPELPADEN.has(pad)) return pad;
  return '/koppelen/…';
}

