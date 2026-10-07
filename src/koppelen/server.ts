import { createHmac, timingSafeEqual } from 'node:crypto';

import { Hono, type Context } from 'hono';

import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Juridisch } from '../config/juridisch.ts';
import type { Backend } from '../db/backend.ts';
import type { Logger } from '../log/logger.ts';
import { maakCreateLink, type KoppelflowOpties } from '../register/koppelflow.ts';
import { valideerEmail } from '../register/nieuweklant.ts';
import { geefUitnodigingVrij, vindGeldigeUitnodiging } from '../register/uitnodiging.ts';
import { clientIp } from '../server/clientip.ts';
import type { UnipileClient } from '../unipile/client.ts';
import { koppelpaginaSleutels } from '../webhooks/geheim.ts';

import { haalKoppelContext, hashIp, legToestemmingVast, type KoppelContext } from './toestemming.ts';
import {
  klaarView,
  koppelPaginaView,
  mislukView,
  ongeldigView,
  unipileFoutView,
  verlopenFormulierView,
  type KoppelLimieten,
} from './views.ts';

/**
 * Publieke koppelpagina's (SPEC §14.2 punt 3–6), zonder login:
 *
 * - `GET  /koppelen/:token`  uitleg + formulier met drie verplichte vinkjes;
 * - `POST /koppelen/:token`  toestemming vastleggen, uitnodiging claimen,
 *   Unipile hosted-auth-link maken en de browser doorsturen (303);
 * - `GET  /koppelen/klaar` en `/koppelen/mislukt`: terugkeer vanaf Unipile.
 *
 * Een ongeldig, verlopen of gebruikt token geeft altijd dezelfde 410-pagina,
 * zodat niet te zien is welk van de drie. CSRF: een HMAC van het token met een
 * van WEBHOOK_SECRET afgeleide sleutel (stateless; geen cookie nodig).
 * Het token staat in de URL: daarom `Referrer-Policy: no-referrer` en
 * `Cache-Control: no-store` op elke pagina.
 */

export interface KoppelDeps {
  db: Backend;
  unipile: UnipileClient;
  klok: Klok;
  limieten: Limieten;
  juridisch: Juridisch;
  /** notify_url, api_url en de redirect-URL's voor Unipile hosted auth. */
  koppelOpties: KoppelflowOpties;
  webhookSecret: string;
  /** Zie AdminDeps.vertrouwProxy. Standaard true. */
  vertrouwProxy?: boolean;
  logger?: Logger;
}

const NAAM_MAX = 200;

export function maakKoppelApp(deps: KoppelDeps) {
  const sleutels = koppelpaginaSleutels(deps.webhookSecret);
  const app = new Hono();

  app.use('/koppelen/*', async (c, next) => {
    await next();
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  // Vaste routes vóór `/:token`.
  app.get('/koppelen/klaar', (c) => c.html(klaarView()));
  app.get('/koppelen/mislukt', (c) => c.html(mislukView()));

  app.get('/koppelen/:token', async (c) => {
    const token = c.req.param('token');
    const uitnodiging = await vindGeldigeUitnodiging(deps.db, token, deps.klok);
    const context = uitnodiging ? await haalKoppelContext(deps.db, uitnodiging.accountId) : null;
    if (!uitnodiging || !context) return ongeldig(c);
    return c.html(
      koppelPaginaView({
        ...paginaBasis(deps, context, token, csrfVoor(sleutels.csrfSleutel, token)),
        naam: context.eigenaarNaam,
        email: context.eigenaarEmail ?? '',
      }),
    );
  });

  app.post('/koppelen/:token', async (c) => {
    const token = c.req.param('token');
    const uitnodiging = await vindGeldigeUitnodiging(deps.db, token, deps.klok);
    const context = uitnodiging ? await haalKoppelContext(deps.db, uitnodiging.accountId) : null;
    if (!uitnodiging || !context) return ongeldig(c);

    const form = await c.req.parseBody();
    const csrf = csrfVoor(sleutels.csrfSleutel, token);
    if (!constanteTijdGelijk(tekst(form, 'csrf'), csrf)) {
      c.status(403);
      return c.html(verlopenFormulierView());
    }

    const naam = tekst(form, 'naam').trim();
    const email = tekst(form, 'email').trim();
    const aangevinkt = {
      eigenaar: tekst(form, 'eigenaar') === 'ja',
      toestemming: tekst(form, 'toestemming') === 'ja',
      voorwaarden: tekst(form, 'voorwaarden') === 'ja',
    };
    const meldingen: string[] = [];
    if (!naam || naam.length > NAAM_MAX) meldingen.push('Vul uw naam in.');
    const emailFout = valideerEmail(email);
    if (emailFout) meldingen.push(emailFout);
    if (!aangevinkt.eigenaar || !aangevinkt.toestemming || !aangevinkt.voorwaarden) {
      meldingen.push('Vink alle drie de verklaringen aan om verder te gaan.');
    }
    if (meldingen.length > 0) {
      c.status(400);
      return c.html(
        koppelPaginaView({
          ...paginaBasis(deps, context, token, csrf),
          naam,
          email,
          aangevinkt,
          foutmelding: meldingen.join(' '),
        }),
      );
    }

    const ip = clientIp(c, deps.vertrouwProxy ?? true);
    const userAgent = c.req.header('user-agent') ?? null;
    const vastgelegd = await legToestemmingVast(
      deps.db,
      {
        uitnodigingId: uitnodiging.id,
        accountId: uitnodiging.accountId,
        naam,
        email,
        versieVoorwaarden: deps.juridisch.voorwaarden.versie,
        versieVerwerkersovereenkomst: deps.juridisch.verwerkersovereenkomst.versie,
        ipHash: ip ? hashIp(sleutels.ipSleutel, ip) : null,
        userAgent,
      },
      deps.klok,
    );
    // Tussen controle en claim door iemand anders gebruikt (dubbel verzonden).
    if (!vastgelegd) return ongeldig(c);

    let url: string;
    try {
      ({ url } = await maakCreateLink(deps.db, deps.unipile, deps.koppelOpties, uitnodiging.accountId));
    } catch (err) {
      // Toestemming blijft staan; de link moet opnieuw te gebruiken zijn.
      await geefUitnodigingVrij(deps.db, uitnodiging.id);
      deps.logger?.warn('Koppelpagina: Unipile-link maken mislukt', {
        account_id: uitnodiging.accountId,
        fout: (err as Error).message,
      });
      c.status(503);
      return c.html(unipileFoutView());
    }
    deps.logger?.info('Koppelpagina: toestemming vastgelegd, door naar Unipile', {
      account_id: uitnodiging.accountId,
    });
    return c.redirect(url, 303);
  });

  return app;
}

function ongeldig(c: Context): Response {
  c.status(410);
  return c.html(ongeldigView()) as Response;
}

function paginaBasis(deps: KoppelDeps, context: KoppelContext, token: string, csrf: string) {
  return {
    token,
    csrf,
    klantNaam: context.klantNaam,
    limieten: limietenVoor(deps.limieten, context),
    voorwaarden: deps.juridisch.voorwaarden,
    verwerkersovereenkomst: deps.juridisch.verwerkersovereenkomst,
  };
}

function limietenVoor(limieten: Limieten, context: KoppelContext): KoppelLimieten {
  const a = limieten.abonnementen[context.abonnement];
  return {
    verzoekenPerDag: a.invite.dag,
    verzoekenPerWeek: a.invite.week,
    berichtenPerDag: a.message.dag,
    berichtenPerWeek: a.message.week,
    startPercentage: Math.round(limieten.opbouw.start_factor * 100),
  };
}

function csrfVoor(sleutel: string, token: string): string {
  return createHmac('sha256', sleutel).update(token).digest('base64url');
}

function constanteTijdGelijk(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function tekst(form: Record<string, unknown>, veld: string): string {
  const w = form[veld];
  return typeof w === 'string' ? w : '';
}
