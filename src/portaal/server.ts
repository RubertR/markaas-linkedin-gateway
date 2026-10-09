import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { aantalGekoppeld, betalingMisluktVoorKlant, vindAbonnement } from '../abonnement/abonnementen.ts';
import {
  AbonnementFout,
  AlAbonnementFout,
  NIET_INGERICHT,
  beheerAbonnement,
  startAbonnement,
  type StripeInrichting,
} from '../abonnement/dienst.ts';
import { beschrijfAbonnement } from '../abonnement/weergave.ts';
import { PogingenTracker } from '../admin/pogingen.ts';
import { maakWachtwoordHash, verifieerWachtwoord } from '../admin/wachtwoord.ts';
import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import type { Logger } from '../log/logger.ts';
import { KoppelflowFout, type KoppelflowOpties } from '../register/koppelflow.ts';
import { NieuweKlantFout } from '../register/nieuweklant.ts';
import { clientIp } from '../server/clientip.ts';
import { StripeFout } from '../stripe/errors.ts';
import type { UnipileClient } from '../unipile/client.ts';
import { leesRondeUitFormulier } from '../profiel/invoer.ts';
import {
  ProfielConflictFout,
  ProfielFout,
  berichtenVoorProfiel,
  dienIn,
  profielActie,
  profielStand,
  slaRondeOp,
  vraagWijzigingAan,
  type ProfielActie,
} from '../profiel/profielen.ts';

import { AdminInvoerFout } from '../admin/dienst.ts';
import {
  PortaalAbonnementFout,
  PortaalKoppelFout,
  PortaalNietGevondenFout,
  conceptenVoorKlant,
  keurAllesGoedVoorKlant,
  keurGoedVoorKlant,
  maakKoppellinkVoorKlant,
  wijsAfVoorKlant,
} from './dienst.ts';
import {
  gebruikUitnodiging,
  normaliseerEmail,
  registreerLogin,
  valideerNieuwWachtwoord,
  vindGebruikerVoorLogin,
  vindGeldigeGebruikerUitnodiging,
} from './gebruikers.ts';
import { profielOverzichtView, profielRondeView } from './profiel-pagina.ts';
import { resultatenVoorKlant } from './resultaten.ts';
import {
  PORTAAL_SESSIE_DUUR_MS,
  maakPortaalSessie,
  ruimVerlopenSessiesOp,
  verwijderPortaalSessie,
  vindPortaalSessie,
  type PortaalSessie,
} from './sessies.ts';
import {
  abonnementTerugView,
  abonnementView,
  conceptenView,
  loginView,
  nietGevondenView,
  ongeldigeUitnodigingView,
  resultatenView,
  verlopenFormulierView,
  wachtwoordKiezenView,
  type Melding,
} from './views.ts';

/**
 * Hono-sub-app voor het klantportaal (SPEC §14.3), onder `/portaal/*`.
 *
 * Beveiliging, in lagen zoals de admin (§12):
 * 1. Sessiecookie `portaal_sessie`: HttpOnly, Secure (productie), SameSite=Lax
 *    (terugkeer van Stripe; alle POST's hebben een CSRF-token, geen GET wijzigt iets),
 *    Path=/portaal, 12 uur. Sessies staan in de database (overleven een herstart).
 * 2. CSRF-token per sessie, verplicht op elke POST. Vóór het inloggen (login,
 *    wachtwoord kiezen) een double-submit-token in een aparte cookie.
 * 3. Brute force: 5 mislukte pogingen per IP óf per e-mailadres → 15 minuten blokkade.
 *    De foutmelding verraadt niet of het e-mailadres bestaat; ook voor onbekende
 *    adressen wordt een scrypt-vergelijking gedaan (gelijke tijd).
 * 4. Afscherming (§14.1): alle gegevens komen via `dienst.ts`/`resultaten.ts`,
 *    die filteren op de klant van de sessie. Een actie of account van een
 *    andere klant geeft 404 en verandert niets.
 */

const SESSIE_COOKIE = 'portaal_sessie';
const CSRF_COOKIE = 'portaal_csrf';
const FLASH_COOKIE = 'portaal_flash';
const PAD = '/portaal';
const GENERIEKE_LOGINFOUT = 'E-mailadres of wachtwoord klopt niet.';

export interface PortaalDeps {
  db: Backend;
  limieten: Limieten;
  klok: Klok;
  unipile: UnipileClient;
  /** Voor reconnect-links (notify_url, api_url). */
  koppelOpties: KoppelflowOpties;
  cookieSecure: boolean;
  /** Zie AdminDeps.vertrouwProxy. Standaard true. */
  vertrouwProxy?: boolean;
  /** Geldigheid van nieuwe koppeluitnodigingen (config/juridisch.json). Standaard 7. */
  koppeluitnodigingGeldigDagen?: number;
  pogingen?: PogingenTracker;
  logger?: Logger;
  /**
   * Abonnement via Stripe (SPEC §14.3, §14.4). Ontbreekt dit of is `stripe`
   * null, dan toont /portaal/abonnement "Betalen is nog niet ingericht".
   */
  abonnement?: {
    stripe: StripeInrichting | null;
    config: AbonnementConfig;
    /** Publieke basis-URL zonder slash aan het eind (success/cancel/return-URL's). */
    publicBaseUrl: string;
  };
  /**
   * Klantprofiel-intake (SPEC §14.6), uit config/intake.json. Ontbreekt dit,
   * dan is er geen tabblad Klantprofiel en gaat de login naar de concepten.
   */
  intake?: Intake;
}

type PortaalContext = Context;

export function maakPortaalApp(deps: PortaalDeps) {
  const pogingen =
    deps.pogingen ??
    new PogingenTracker({ maxFouten: 5, blokkadeMs: 15 * 60 * 1000, klok: deps.klok });
  // Hash om tegen te vergelijken als het adres onbekend is (gelijke tijd).
  let dummyHash: Promise<string> | null = null;
  const vergelijkHash = () => (dummyHash ??= maakWachtwoordHash(randomBytes(24).toString('base64url')));

  const app = new Hono();

  app.use(`${PAD}/*`, async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.get(PAD, (c) => c.redirect(`${PAD}/`, 301));

  // -- inloggen ------------------------------------------------------------

  app.get(`${PAD}/login`, async (c) => {
    if (await laadSessie(c, deps)) return c.redirect(`${PAD}/`, 303);
    return c.html(loginView({ csrfToken: preCsrf(c, deps) }));
  });

  app.post(`${PAD}/login`, async (c) => {
    const form = await c.req.parseBody();
    const email = normaliseerEmail(tekst(form, 'email'));
    const wachtwoord = tekst(form, 'wachtwoord');
    if (!gelijk(tekst(form, 'csrf'), getCookie(c, CSRF_COOKIE) ?? '')) {
      c.status(403);
      return c.html(loginView({ csrfToken: preCsrf(c, deps), email, foutmelding: 'Formulier verlopen; probeer opnieuw.' }));
    }
    const ipSleutel = `ip:${clientIp(c, deps.vertrouwProxy ?? true) ?? 'onbekend'}`;
    const emailSleutel = `email:${email}`;
    const geblokkeerd = [ipSleutel, emailSleutel].filter((s) => pogingen.isGeblokkeerd(s));
    if (geblokkeerd.length > 0) {
      c.status(429);
      return c.html(
        loginView({
          csrfToken: preCsrf(c, deps),
          email,
          blokkadeSeconden: Math.max(...geblokkeerd.map((s) => pogingen.resterendSeconden(s))),
        }),
      );
    }

    const gevonden = email ? await vindGebruikerVoorLogin(deps.db, email) : null;
    const hash = gevonden?.wachtwoordHash ?? (await vergelijkHash());
    const wachtwoordJuist = await verifieerWachtwoord(hash, wachtwoord);
    const juist =
      wachtwoordJuist &&
      gevonden !== null &&
      gevonden.wachtwoordHash !== null &&
      gevonden.gebruiker.actief &&
      gevonden.klantActief;
    if (!juist || !gevonden) {
      pogingen.registreerFout(ipSleutel);
      pogingen.registreerFout(emailSleutel);
      c.status(401);
      return c.html(loginView({ csrfToken: preCsrf(c, deps), email, foutmelding: GENERIEKE_LOGINFOUT }));
    }
    pogingen.reset(ipSleutel);
    pogingen.reset(emailSleutel);
    await registreerLogin(deps.db, gevonden.gebruiker.id, deps.klok);
    return await startSessie(c, deps, gevonden.gebruiker.id, gevonden.gebruiker.clientId);
  });

  app.post(`${PAD}/logout`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (sessie) {
      const form = await c.req.parseBody();
      if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
      await verwijderPortaalSessie(deps.db, getCookie(c, SESSIE_COOKIE));
    }
    deleteCookie(c, SESSIE_COOKIE, { path: PAD });
    return c.redirect(`${PAD}/login`, 303);
  });

  // -- uitnodiging: wachtwoord kiezen --------------------------------------

  app.get(`${PAD}/uitnodiging/:token`, async (c) => {
    const token = c.req.param('token');
    const u = await vindGeldigeGebruikerUitnodiging(deps.db, token, deps.klok);
    if (!u) return ongeldig(c);
    return c.html(
      wachtwoordKiezenView({ token, csrfToken: preCsrf(c, deps), naam: u.naam, email: u.email, klantNaam: u.klantNaam }),
    );
  });

  app.post(`${PAD}/uitnodiging/:token`, async (c) => {
    const token = c.req.param('token');
    const u = await vindGeldigeGebruikerUitnodiging(deps.db, token, deps.klok);
    if (!u) return ongeldig(c);
    const form = await c.req.parseBody();
    if (!gelijk(tekst(form, 'csrf'), getCookie(c, CSRF_COOKIE) ?? '')) {
      c.status(403);
      return c.html(verlopenFormulierView());
    }
    const fout = valideerNieuwWachtwoord(tekst(form, 'wachtwoord'), tekst(form, 'herhaling'));
    if (fout) {
      c.status(400);
      return c.html(
        wachtwoordKiezenView({
          token,
          csrfToken: preCsrf(c, deps),
          naam: u.naam,
          email: u.email,
          klantNaam: u.klantNaam,
          foutmelding: fout,
        }),
      );
    }
    const hash = await maakWachtwoordHash(tekst(form, 'wachtwoord'));
    const gebruiker = await gebruikUitnodiging(deps.db, token, hash, deps.klok);
    // Tussen controle en opslaan door iemand anders gebruikt (dubbel verzonden).
    if (!gebruiker) return ongeldig(c);
    deps.logger?.info('Klantportaal: wachtwoord gekozen via uitnodiging', { client_user_id: gebruiker.id });
    await registreerLogin(deps.db, gebruiker.id, deps.klok);
    return await startSessie(c, deps, gebruiker.id, gebruiker.clientId);
  });

  // -- concepten -----------------------------------------------------------

  app.get(`${PAD}/`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const concepten = await conceptenVoorKlant(deps.db, sessie.clientId, {
      limieten: deps.limieten,
      klok: deps.klok,
    });
    const opts: Parameters<typeof conceptenView>[0] = {
      klantNaam: sessie.klantNaam,
      csrfToken: sessie.csrfToken,
      concepten,
      betalingMislukt: await betalingMislukt(deps, sessie.clientId),
    };
    const actie = await profielActieVoor(deps, sessie.clientId);
    if (actie) opts.profielActie = actie;
    const melding = leesFlash(c);
    if (melding) opts.melding = melding;
    return c.html(conceptenView(opts));
  });

  app.post(`${PAD}/acties/goedkeuren`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const form = await c.req.parseBody();
    if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
    try {
      await keurGoedVoorKlant(deps.db, sessie, tekst(form, 'actieId'), {
        limieten: deps.limieten,
        klok: deps.klok,
      });
      zetFlash(c, deps, { soort: 'ok', tekst: 'Concept goedgekeurd. Het wordt verstuurd binnen de afgesproken limieten.' });
    } catch (err) {
      if (err instanceof PortaalNietGevondenFout) return nietGevonden(c, err);
      zetFlash(c, deps, { soort: 'fout', tekst: toonbareFout(deps, err, 'goedkeuren') });
    }
    return c.redirect(`${PAD}/`, 303);
  });

  app.post(`${PAD}/acties/afwijzen`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const form = await c.req.parseBody();
    if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
    try {
      await wijsAfVoorKlant(deps.db, sessie, tekst(form, 'actieId'), tekst(form, 'reden').slice(0, 500), {
        limieten: deps.limieten,
      });
      zetFlash(c, deps, { soort: 'ok', tekst: 'Concept afgewezen; het wordt niet verstuurd.' });
    } catch (err) {
      if (err instanceof PortaalNietGevondenFout) return nietGevonden(c, err);
      zetFlash(c, deps, { soort: 'fout', tekst: toonbareFout(deps, err, 'afwijzen') });
    }
    return c.redirect(`${PAD}/`, 303);
  });

  app.post(`${PAD}/acties/goedkeuren-alles`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const form = await c.req.parseBody({ all: true });
    if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
    const ruw = form['ids'];
    const ids = (Array.isArray(ruw) ? ruw : [ruw]).filter((v): v is string => typeof v === 'string');
    if (ids.length === 0) {
      zetFlash(c, deps, { soort: 'fout', tekst: 'Er waren geen concepten om goed te keuren.' });
      return c.redirect(`${PAD}/`, 303);
    }
    try {
      const r = await keurAllesGoedVoorKlant(deps.db, sessie, ids, { limieten: deps.limieten, klok: deps.klok });
      const overgeslagen = r.overgeslagen.length;
      zetFlash(c, deps, {
        soort: overgeslagen === 0 ? 'ok' : 'fout',
        tekst:
          `${r.goedgekeurd.length} ${r.goedgekeurd.length === 1 ? 'concept' : 'concepten'} goedgekeurd.` +
          (overgeslagen > 0
            ? ` ${overgeslagen} niet goedgekeurd: ${[
                ...new Set(r.overgeslagen.map((o) => (o.bekend ? o.reden : ALGEMENE_FOUT))),
              ].join(' ')}`
            : ''),
      });
      for (const o of r.overgeslagen.filter((x) => !x.bekend)) {
        deps.logger?.warn('Klantportaal: goedkeuren mislukt', { actie_id: o.actieId, fout: o.reden });
      }
    } catch (err) {
      if (err instanceof PortaalNietGevondenFout) return nietGevonden(c, err);
      zetFlash(c, deps, { soort: 'fout', tekst: toonbareFout(deps, err, 'alles goedkeuren') });
    }
    return c.redirect(`${PAD}/`, 303);
  });

  // -- resultaten ----------------------------------------------------------

  app.get(`${PAD}/resultaten`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const opts: Parameters<typeof resultatenView>[0] = {
      klantNaam: sessie.klantNaam,
      csrfToken: sessie.csrfToken,
      accounts: await resultatenVoorKlant(deps.db, sessie.clientId, deps.klok),
      betalingMislukt: await betalingMislukt(deps, sessie.clientId),
    };
    const actie = await profielActieVoor(deps, sessie.clientId);
    if (actie) opts.profielActie = actie;
    const melding = leesFlash(c);
    if (melding) opts.melding = melding;
    return c.html(resultatenView(opts));
  });

  app.post(`${PAD}/accounts/:accountId/opnieuw-koppelen`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const form = await c.req.parseBody();
    if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
    const accountId = c.req.param('accountId');
    try {
      const { url } = await maakKoppellinkVoorKlant(
        {
          db: deps.db,
          unipile: deps.unipile,
          koppelOpties: deps.koppelOpties,
          uitnodigingOpties: { klok: deps.klok, geldigDagen: deps.koppeluitnodigingGeldigDagen ?? 7 },
          klok: deps.klok,
        },
        sessie.clientId,
        accountId,
      );
      deps.logger?.info('Klantportaal: (her)koppellink gemaakt', { account_id: accountId });
      return c.redirect(url, 303);
    } catch (err) {
      if (err instanceof PortaalNietGevondenFout) return nietGevonden(c, err);
      if (err instanceof PortaalKoppelFout || err instanceof KoppelflowFout || err instanceof NieuweKlantFout) {
        zetFlash(c, deps, { soort: 'fout', tekst: err.message });
        return c.redirect(`${PAD}/resultaten`, 303);
      }
      deps.logger?.warn('Klantportaal: (her)koppellink maken mislukt', {
        account_id: accountId,
        fout: (err as Error).message,
      });
      zetFlash(c, deps, {
        soort: 'fout',
        tekst: 'Het maken van de koppellink lukte niet. Probeer het later opnieuw of neem contact op met MARKaaS.',
      });
      return c.redirect(`${PAD}/resultaten`, 303);
    }
  });

  // -- abonnement (SPEC §14.3, §14.4) --------------------------------------

  app.get(`${PAD}/abonnement`, async (c) => {
    const sessie = await laadSessie(c, deps);
    if (!sessie) return naarLogin(c);
    const [klant] = await deps.db.query<{ abonnement_vereist: boolean }>(
      'select abonnement_vereist from clients where id = $1',
      [sessie.clientId],
    );
    const abonnement = await vindAbonnement(deps.db, sessie.clientId);
    const opts: Parameters<typeof abonnementView>[0] = {
      klantNaam: sessie.klantNaam,
      csrfToken: sessie.csrfToken,
      weergave: beschrijfAbonnement(klant?.abonnement_vereist ?? true, abonnement),
      aantalAccounts: await aantalGekoppeld(deps.db, sessie.clientId),
      stripeIngericht: Boolean(deps.abonnement?.stripe),
      proefperiodeDagen: deps.abonnement?.config.proefperiode_dagen ?? 0,
      betalingMislukt: await betalingMislukt(deps, sessie.clientId),
    };
    const actie = await profielActieVoor(deps, sessie.clientId);
    if (actie) opts.profielActie = actie;
    const melding = leesFlash(c);
    if (melding) opts.melding = melding;
    return c.html(abonnementView(opts));
  });

  for (const [actie, uitvoeren] of [
    ['starten', (clientId: string, email: string) => startAbonnement(abonnementDeps(deps), clientId, { email })],
    ['beheren', (clientId: string) => beheerAbonnement(abonnementDeps(deps), clientId)],
  ] as const) {
    app.post(`${PAD}/abonnement/${actie}`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const form = await c.req.parseBody();
      if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
      try {
        // Altijd de klant van de sessie; customer-id's komen nooit uit het formulier.
        const url = await uitvoeren(sessie.clientId, sessie.email);
        deps.logger?.info(`Klantportaal: abonnement ${actie}, door naar Stripe`, { client_id: sessie.clientId });
        return c.redirect(url, 303);
      } catch (err) {
        if (err instanceof AlAbonnementFout) {
          // Loopt er al een abonnement (ook als de webhook nog niet binnen is):
          // niet opnieuw afrekenen, maar door naar "Abonnement beheren".
          zetFlash(c, deps, { soort: 'fout', tekst: err.message });
          try {
            return c.redirect(await beheerAbonnement(abonnementDeps(deps), sessie.clientId), 303);
          } catch (fout) {
            deps.logger?.warn('Klantportaal: doorsturen naar Abonnement beheren mislukt', {
              client_id: sessie.clientId,
              fout: (fout as Error).message,
            });
          }
        } else if (err instanceof AbonnementFout) {
          zetFlash(c, deps, { soort: 'fout', tekst: err.message });
        } else if (err instanceof StripeFout) {
          deps.logger?.warn(`Klantportaal: abonnement ${actie} mislukt bij Stripe`, {
            client_id: sessie.clientId,
            fout: err.message,
          });
          zetFlash(c, deps, {
            soort: 'fout',
            tekst: 'Stripe is op dit moment niet bereikbaar of gaf een fout. Probeer het later opnieuw of neem contact op met MARKaaS.',
          });
        } else {
          throw err;
        }
        return c.redirect(`${PAD}/abonnement`, 303);
      }
    });
  }

  for (const soort of ['gelukt', 'geannuleerd'] as const) {
    app.get(`${PAD}/abonnement/${soort}`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const actie = await profielActieVoor(deps, sessie.clientId);
      return c.html(
        abonnementTerugView({
          soort,
          klantNaam: sessie.klantNaam,
          csrfToken: sessie.csrfToken,
          betalingMislukt: await betalingMislukt(deps, sessie.clientId),
          ...(actie ? { profielActie: actie } : {}),
        }),
      );
    });
  }

  // -- klantprofiel (SPEC §14.6) --------------------------------------------

  if (deps.intake) {
    const intake = deps.intake;

    app.get(`${PAD}/profiel`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const stand = await profielStand(deps.db, sessie.clientId);
      const opts: Parameters<typeof profielOverzichtView>[0] = {
        klantNaam: sessie.klantNaam,
        csrfToken: sessie.csrfToken,
        intake,
        stand,
        actie: profielActie(stand),
        betalingMislukt: await betalingMislukt(deps, sessie.clientId),
      };
      const getoond = stand.open ?? stand.vastgesteld;
      if (getoond) opts.berichten = await berichtenVoorProfiel(deps.db, sessie.clientId, getoond.id);
      const melding = leesFlash(c);
      if (melding) opts.melding = melding;
      return c.html(profielOverzichtView(opts));
    });

    app.post(`${PAD}/profiel/indienen`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const form = await c.req.parseBody();
      if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
      try {
        await dienIn(deps.db, {
          clientId: sessie.clientId,
          revisie: geheelGetal(tekst(form, 'revisie')),
          door: `klant:${sessie.email}`,
          intake,
          klok: deps.klok,
          antwoord: tekst(form, 'antwoord'),
        });
        deps.logger?.info('Klantportaal: klantprofiel ingediend', { client_id: sessie.clientId });
        zetFlash(c, deps, {
          soort: 'ok',
          tekst: 'Uw klantprofiel is ingediend bij MARKaaS. U ziet het hier zodra het is vastgesteld of als er een vraag is.',
        });
      } catch (err) {
        if (!(err instanceof ProfielFout)) throw err;
        zetFlash(c, deps, { soort: 'fout', tekst: err.message });
      }
      return c.redirect(`${PAD}/profiel`, 303);
    });

    app.post(`${PAD}/profiel/wijziging`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const form = await c.req.parseBody();
      if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
      try {
        await vraagWijzigingAan(deps.db, { clientId: sessie.clientId, klok: deps.klok });
        return c.redirect(`${PAD}/profiel/${intake.rondes[0]!.id}`, 303);
      } catch (err) {
        if (!(err instanceof ProfielFout)) throw err;
        zetFlash(c, deps, { soort: 'fout', tekst: err.message });
        return c.redirect(`${PAD}/profiel`, 303);
      }
    });

    app.get(`${PAD}/profiel/:ronde`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const ronde = intake.rondes.find((r) => r.id === c.req.param('ronde'));
      if (!ronde) return nietGevonden(c, new Error('Deze ronde van het klantprofiel bestaat niet.'));
      const stand = await profielStand(deps.db, sessie.clientId);
      const actie = profielActie(stand);
      // Alleen bewerkbaar zonder ingediende versie en zonder vastgesteld profiel zonder open wijziging.
      if (actie === 'ingediend' || actie === 'klaar') return c.redirect(`${PAD}/profiel`, 303);
      const opts: Parameters<typeof profielRondeView>[0] = {
        klantNaam: sessie.klantNaam,
        csrfToken: sessie.csrfToken,
        intake,
        ronde,
        antwoorden: stand.open?.antwoorden ?? {},
        revisie: stand.open?.revisie ?? 0,
        accountNamen: await accountNamen(deps, sessie.clientId),
        actie,
        vraagVanMarkaas: stand.open?.vraagVanMarkaas ?? null,
        betalingMislukt: await betalingMislukt(deps, sessie.clientId),
      };
      const melding = leesFlash(c);
      if (melding) opts.melding = melding;
      return c.html(profielRondeView(opts));
    });

    app.post(`${PAD}/profiel/:ronde`, async (c) => {
      const sessie = await laadSessie(c, deps);
      if (!sessie) return naarLogin(c);
      const index = intake.rondes.findIndex((r) => r.id === c.req.param('ronde'));
      const ronde = intake.rondes[index];
      if (!ronde) return nietGevonden(c, new Error('Deze ronde van het klantprofiel bestaat niet.'));
      const form = await c.req.parseBody({ all: true });
      if (!gelijk(tekst(form, 'csrf'), sessie.csrfToken)) return csrfFout(c);
      const revisie = geheelGetal(tekst(form, 'revisie'));
      const invoer = leesRondeUitFormulier(ronde, form);
      if (invoer.fouten.length > 0) {
        // Ingevulde waarden terugtonen, niets opslaan.
        const stand = await profielStand(deps.db, sessie.clientId);
        c.status(400);
        return c.html(
          profielRondeView({
            klantNaam: sessie.klantNaam,
            csrfToken: sessie.csrfToken,
            intake,
            ronde,
            antwoorden: { ...(stand.open?.antwoorden ?? {}), ...invoer.weergave },
            revisie,
            accountNamen: await accountNamen(deps, sessie.clientId),
            actie: profielActie(stand),
            vraagVanMarkaas: stand.open?.vraagVanMarkaas ?? null,
            melding: { soort: 'fout', tekst: invoer.fouten.join(' ') },
          }),
        );
      }
      try {
        await slaRondeOp(deps.db, {
          clientId: sessie.clientId,
          antwoorden: invoer.antwoorden,
          revisie,
          intake,
          klok: deps.klok,
        });
      } catch (err) {
        if (err instanceof ProfielConflictFout) {
          zetFlash(c, deps, { soort: 'fout', tekst: err.message });
          return c.redirect(`${PAD}/profiel/${ronde.id}`, 303);
        }
        if (!(err instanceof ProfielFout)) throw err;
        zetFlash(c, deps, { soort: 'fout', tekst: err.message });
        return c.redirect(`${PAD}/profiel`, 303);
      }
      const richting = tekst(form, 'richting');
      const doel =
        richting === 'vorige' && index > 0
          ? `${PAD}/profiel/${intake.rondes[index - 1]!.id}`
          : index < intake.rondes.length - 1
            ? `${PAD}/profiel/${intake.rondes[index + 1]!.id}`
            : `${PAD}/profiel`;
      return c.redirect(doel, 303);
    });
  }

  return app;
}

async function accountNamen(deps: PortaalDeps, clientId: string): Promise<string[]> {
  const rijen = await deps.db.query<{ eigenaar_naam: string }>(
    'select eigenaar_naam from accounts where client_id = $1 order by eigenaar_naam',
    [clientId],
  );
  return rijen.map((r) => r.eigenaar_naam);
}

function geheelGetal(w: string): number {
  const n = Number.parseInt(w, 10);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

// -- hulpjes ---------------------------------------------------------------

export const ALGEMENE_FOUT = 'Er ging iets mis; probeer het opnieuw of neem contact op met MARKaaS.';

/**
 * Alleen eigen foutklassen met een NL-tekst voor de klant worden letterlijk
 * getoond; andere fouten (interne details, id's) worden gelogd en vervangen
 * door een algemene melding (SPEC §14.3).
 */
function toonbareFout(deps: PortaalDeps, err: unknown, wat: string): string {
  if (
    err instanceof PortaalAbonnementFout ||
    err instanceof PortaalKoppelFout ||
    err instanceof AdminInvoerFout ||
    err instanceof AbonnementFout
  ) {
    return err.message;
  }
  deps.logger?.warn(`Klantportaal: ${wat} mislukt`, { fout: (err as Error)?.message ?? String(err) });
  return ALGEMENE_FOUT;
}

function abonnementDeps(deps: PortaalDeps) {
  if (!deps.abonnement) throw new AbonnementFout(NIET_INGERICHT);
  return { db: deps.db, klok: deps.klok, ...deps.abonnement };
}

async function betalingMislukt(deps: PortaalDeps, clientId: string): Promise<boolean> {
  if (deps.abonnement && !deps.abonnement.config.waarschuwing_past_due) return false;
  return await betalingMisluktVoorKlant(deps.db, clientId);
}

async function laadSessie(c: PortaalContext, deps: PortaalDeps): Promise<PortaalSessie | null> {
  return await vindPortaalSessie(deps.db, getCookie(c, SESSIE_COOKIE), deps.klok);
}

async function startSessie(
  c: PortaalContext,
  deps: PortaalDeps,
  gebruikerId: string,
  clientId: string,
): Promise<Response> {
  // Verlopen sessies opruimen bij elke nieuwe login (weinig gebruikers, goedkoop).
  await ruimVerlopenSessiesOp(deps.db, deps.klok);
  // Altijd een nieuw token (geen session fixation).
  const sessie = await maakPortaalSessie(deps.db, gebruikerId, { klok: deps.klok });
  // Lax (niet Strict): na terugkeer van Stripe (top-level GET vanaf een ander
  // domein) moet de sessie meekomen. Veilig omdat elke POST een CSRF-token per
  // sessie eist en geen enkele GET iets wijzigt.
  setCookie(c, SESSIE_COOKIE, sessie.token, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'Lax',
    path: PAD,
    maxAge: Math.floor(PORTAAL_SESSIE_DUUR_MS / 1000),
  });
  deleteCookie(c, CSRF_COOKIE, { path: PAD });
  // SPEC §14.6: zolang het klantprofiel niet is ingediend (of er een vraag van
  // MARKaaS ligt), begint de klant na het inloggen bij het klantprofiel.
  const actie = await profielActieVoor(deps, clientId);
  const doel = actie === 'invullen' || actie === 'vraag' ? `${PAD}/profiel` : `${PAD}/`;
  return c.redirect(doel, 303) as Response;
}

async function profielActieVoor(deps: PortaalDeps, clientId: string): Promise<ProfielActie | undefined> {
  if (!deps.intake) return undefined;
  return profielActie(await profielStand(deps.db, clientId));
}

function naarLogin(c: PortaalContext): Response {
  return c.redirect(`${PAD}/login`, 303) as Response;
}

function ongeldig(c: PortaalContext): Response {
  c.status(410);
  return c.html(ongeldigeUitnodigingView()) as Response;
}

function nietGevonden(c: PortaalContext, err: Error): Response {
  c.status(404);
  return c.html(nietGevondenView(err.message)) as Response;
}

function csrfFout(c: PortaalContext): Response {
  c.status(403);
  return c.html(verlopenFormulierView()) as Response;
}

function preCsrf(c: PortaalContext, deps: PortaalDeps): string {
  const bestaand = getCookie(c, CSRF_COOKIE);
  if (bestaand) return bestaand;
  const nieuw = randomBytes(24).toString('base64url');
  setCookie(c, CSRF_COOKIE, nieuw, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'Strict',
    path: PAD,
    maxAge: 60 * 60,
  });
  return nieuw;
}

function gelijk(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function tekst(form: Record<string, unknown>, veld: string): string {
  const w = form[veld];
  if (typeof w === 'string') return w;
  if (Array.isArray(w) && typeof w[0] === 'string') return w[0];
  return '';
}

function zetFlash(c: PortaalContext, deps: PortaalDeps, melding: Melding): void {
  // Lax: een melding die vóór het doorsturen naar Stripe is gezet, moet bij terugkeer zichtbaar zijn.
  setCookie(c, FLASH_COOKIE, `${melding.soort}:${melding.tekst}`, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'Lax',
    path: PAD,
    maxAge: 30,
  });
}

function leesFlash(c: PortaalContext): Melding | undefined {
  const w = getCookie(c, FLASH_COOKIE);
  if (!w) return undefined;
  deleteCookie(c, FLASH_COOKIE, { path: PAD });
  const [soort, ...rest] = w.split(':');
  if (soort !== 'ok' && soort !== 'fout') return undefined;
  return { soort, tekst: rest.join(':') };
}
