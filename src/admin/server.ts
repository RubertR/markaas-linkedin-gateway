import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import type { Abonnement } from '../register/accounts.ts';
import {
  NieuweKlantFout,
  maakNieuweKlant,
  maakNieuweKoppeluitnodiging,
} from '../register/nieuweklant.ts';
import { ABONNEMENTEN, maakSlug } from '../register/registreer.ts';
import type { NieuweUitnodiging } from '../register/uitnodiging.ts';
import { clientIp } from '../server/clientip.ts';

import {
  goedkeur,
  goedkeurBatch,
  herapproveOnzeker,
  lijstDrafts,
  lijstOnzeker,
  markeerOnzekerAlsDone,
  wijsAf,
} from './dienst.ts';
import { PogingenTracker } from './pogingen.ts';
import { SessieStore, type Sessie } from './sessie.ts';
import { verifieerWachtwoord } from './wachtwoord.ts';
import { haalAccountVoorKoppellink, lijstKlanten } from './klanten.ts';
import {
  klantenView,
  koppellinkView,
  loginView,
  nieuweKlantView,
  overzichtView,
  type NieuweKlantWaarden,
} from './views.ts';

/**
 * Hono-sub-app voor de goedkeuringspagina (SPEC §12). Routes zitten onder
 * `/admin/*` zodat deze geïntegreerd kan worden in de bestaande HTTP-server
 * naast `/webhooks/*` en `/mcp`.
 *
 * Beveiliging in lagen:
 * 1. Sessiecookie HttpOnly, Secure, SameSite=Strict (12 uur).
 * 2. CSRF-token per sessie, verplicht op elk formulier (POST).
 * 3. Brute-force: 5 foute pogingen → 15 min blokkade per IP.
 */

const SESSIE_COOKIE = 'admin_sessie';
const CSRF_COOKIE = 'admin_csrf'; // voor pre-login formulieren
const FLASH_COOKIE = 'admin_flash';
const SESSIE_DUUR_MS = 12 * 60 * 60 * 1000;

type AdminVars = { sessie: Sessie };
type AdminEnv = { Variables: AdminVars };
type AdminContext = Context<AdminEnv>;

export interface AdminDeps {
  db: Backend;
  limieten: Limieten;
  klok: Klok;
  wachtwoordHash: string;
  cookieSecure: boolean;
  /**
   * Vertrouw `X-Forwarded-For`/`X-Real-IP` voor het client-IP (brute-force-
   * blokkade). Alleen aanzetten achter een proxy die deze headers zelf zet,
   * zoals Railway in productie. Standaard `true` (gedrag van ronde 2).
   */
  vertrouwProxy?: boolean;
  /**
   * Publieke basis-URL van de gateway (zonder slash aan het eind) voor de
   * koppellinks op `/admin/klanten` (`<publicBaseUrl>/koppelen/<token>`).
   * Standaard `http://localhost:3000`.
   */
  publicBaseUrl?: string;
  /** Geldigheid van koppeluitnodigingen (config/juridisch.json). Standaard 7. */
  koppeluitnodigingGeldigDagen?: number;
  /** Standaard: in-memory stores. Tests kunnen eigen instances meegeven. */
  sessies?: SessieStore;
  pogingen?: PogingenTracker;
}

export function maakAdminApp(deps: AdminDeps) {
  const sessies = deps.sessies ?? new SessieStore({ duurMs: SESSIE_DUUR_MS, klok: deps.klok });
  const pogingen =
    deps.pogingen ??
    new PogingenTracker({ maxFouten: 5, blokkadeMs: 15 * 60 * 1000, klok: deps.klok });

  const app = new Hono<AdminEnv>();

  // Hono is strikt met slashes: zonder deze route geeft /admin een 404.
  app.get('/admin', (c) => c.redirect('/admin/', 301));

  // -- login --------------------------------------------------------------

  app.get('/admin/login', (c) => {
    const csrf = krijgOfMaakPreCsrf(c, deps);
    return c.html(loginView({ csrfToken: csrf }));
  });

  app.post('/admin/login', async (c) => {
    const sleutel = clientSleutel(c, deps.vertrouwProxy ?? true);
    if (pogingen.isGeblokkeerd(sleutel)) {
      const csrf = krijgOfMaakPreCsrf(c, deps);
      c.status(429);
      return c.html(
        loginView({
          csrfToken: csrf,
          blokkadeSeconden: pogingen.resterendSeconden(sleutel),
        }),
      );
    }
    const form = await c.req.parseBody();
    const wachtwoord = getString(form, 'wachtwoord');
    const csrfForm = getString(form, 'csrf');
    const csrfCookie = getCookie(c, CSRF_COOKIE) ?? '';
    if (!csrfConstanteTijdGelijk(csrfForm, csrfCookie)) {
      c.status(403);
      return c.html(
        loginView({
          csrfToken: krijgOfMaakPreCsrf(c, deps),
          foutmelding: 'Formulier verlopen; probeer opnieuw.',
        }),
      );
    }
    const juist = await verifieerWachtwoord(deps.wachtwoordHash, wachtwoord);
    if (!juist) {
      pogingen.registreerFout(sleutel);
      c.status(401);
      return c.html(
        loginView({
          csrfToken: krijgOfMaakPreCsrf(c, deps),
          foutmelding: 'Onjuist wachtwoord.',
        }),
      );
    }
    pogingen.reset(sleutel);
    const sessie = sessies.maak('rubert');
    setCookie(c, SESSIE_COOKIE, sessie.id, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'Strict',
      path: '/admin',
      maxAge: Math.floor(SESSIE_DUUR_MS / 1000),
    });
    deleteCookie(c, CSRF_COOKIE, { path: '/admin' });
    return c.redirect('/admin/', 303);
  });

  app.post('/admin/logout', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (sessie) {
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const csrfForm = getString(form, 'csrf');
      if (!csrfConstanteTijdGelijk(csrfForm, sessie.csrfToken)) {
        c.status(403);
        return c.text('CSRF-token ontbreekt of klopt niet.');
      }
      sessies.verwijder(sessie.id);
    }
    deleteCookie(c, SESSIE_COOKIE, { path: '/admin' });
    return c.redirect('/admin/login', 303);
  });

  // -- beveiligde routes --------------------------------------------------

  app.get('/admin/', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    c.set('sessie', sessie);
    const melding = flashUitCookie(c);
    const drafts = await lijstDrafts(deps.db, { limieten: deps.limieten, klok: deps.klok });
    const onzeker = await lijstOnzeker(deps.db);
    const opts: Parameters<typeof overzichtView>[0] = {
      csrfToken: sessie.csrfToken,
      drafts,
      onzeker,
    };
    if (melding) opts.melding = melding;
    return c.html(overzichtView(opts));
  });

  app.post('/admin/acties/goedkeuren', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody();
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    const actieId = getString(form, 'actieId');
    const nieuweTekstRaw = getString(form, 'nieuweTekst');
    try {
      const opts: Parameters<typeof goedkeur>[2] = {
        klok: deps.klok,
        limieten: deps.limieten,
      };
      if (nieuweTekstRaw.trim() !== '') opts.nieuweTekst = nieuweTekstRaw;
      await goedkeur(deps.db, actieId, opts);
      zetFlash(c, deps, { soort: 'ok', tekst: 'Actie goedgekeurd.' });
    } catch (err) {
      zetFlash(c, deps, { soort: 'fout', tekst: (err as Error).message });
    }
    return c.redirect('/admin/', 303);
  });

  app.post('/admin/acties/goedkeuren-batch', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody({ all: true });
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    const batchRaw = form['batch'];
    const ids: string[] = Array.isArray(batchRaw)
      ? batchRaw.filter((v): v is string => typeof v === 'string')
      : typeof batchRaw === 'string'
        ? [batchRaw]
        : [];
    if (ids.length === 0) {
      zetFlash(c, deps, { soort: 'fout', tekst: 'Geen acties geselecteerd voor batch.' });
      return c.redirect('/admin/', 303);
    }
    const r = await goedkeurBatch(deps.db, ids, { klok: deps.klok });
    zetFlash(c, deps, {
      soort: r.overgeslagen.length === 0 ? 'ok' : 'fout',
      tekst: `${r.goedgekeurd.length} goedgekeurd${
        r.overgeslagen.length > 0 ? `, ${r.overgeslagen.length} overgeslagen` : ''
      }.`,
    });
    return c.redirect('/admin/', 303);
  });

  app.post('/admin/acties/afwijzen', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody();
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    try {
      await wijsAf(deps.db, getString(form, 'actieId'), getString(form, 'reden'), {
        limieten: deps.limieten,
      });
      zetFlash(c, deps, { soort: 'ok', tekst: 'Actie afgewezen.' });
    } catch (err) {
      zetFlash(c, deps, { soort: 'fout', tekst: (err as Error).message });
    }
    return c.redirect('/admin/', 303);
  });

  app.post('/admin/acties/onzeker-done', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody();
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    try {
      await markeerOnzekerAlsDone(deps.db, getString(form, 'actieId'), deps.klok);
      zetFlash(c, deps, { soort: 'ok', tekst: 'Onzeker-actie op done gezet.' });
    } catch (err) {
      zetFlash(c, deps, { soort: 'fout', tekst: (err as Error).message });
    }
    return c.redirect('/admin/', 303);
  });

  app.post('/admin/acties/onzeker-opnieuw', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody();
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    try {
      await herapproveOnzeker(deps.db, getString(form, 'actieId'), deps.klok);
      zetFlash(c, deps, { soort: 'ok', tekst: 'Onzeker-actie opnieuw goedgekeurd.' });
    } catch (err) {
      zetFlash(c, deps, { soort: 'fout', tekst: (err as Error).message });
    }
    return c.redirect('/admin/', 303);
  });

  // -- klanten en koppellinks (SPEC §14.2) --------------------------------

  const uitnodigingOpties = () => ({
    klok: deps.klok,
    geldigDagen: deps.koppeluitnodigingGeldigDagen ?? 7,
  });
  const basisUrl = (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');

  async function toonKoppellink(
    c: AdminContext,
    sessie: Sessie,
    uitnodiging: NieuweUitnodiging,
  ): Promise<Response> {
    const info = await haalAccountVoorKoppellink(deps.db, uitnodiging.accountId);
    // Het token staat alleen in deze ene response; niet laten cachen.
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(
      koppellinkView({
        csrfToken: sessie.csrfToken,
        link: `${basisUrl}/koppelen/${uitnodiging.token}`,
        klantNaam: info?.klantNaam ?? '',
        eigenaarNaam: info?.eigenaarNaam ?? '',
        eigenaarEmail: info?.eigenaarEmail ?? null,
        verlooptOp: uitnodiging.verlooptOp,
      }),
    ) as Response;
  }

  app.get('/admin/klanten', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const melding = flashUitCookie(c);
    const opts: Parameters<typeof klantenView>[0] = {
      csrfToken: sessie.csrfToken,
      klanten: await lijstKlanten(deps.db, deps.klok),
    };
    if (melding) opts.melding = melding;
    return c.html(klantenView(opts));
  });

  app.get('/admin/klanten/nieuw', (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    return c.html(nieuweKlantView({ csrfToken: sessie.csrfToken, abonnementen: ABONNEMENTEN }));
  });

  app.post('/admin/klanten/nieuw', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody();
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    const klantNaam = getString(form, 'klantNaam').trim();
    const waarden: NieuweKlantWaarden = {
      klantNaam,
      slug: getString(form, 'slug').trim() || slugVoorstel(klantNaam),
      eigenaarNaam: getString(form, 'eigenaarNaam').trim(),
      eigenaarEmail: getString(form, 'eigenaarEmail').trim(),
      abonnement: getString(form, 'abonnement'),
      abonnementVereist: getString(form, 'abonnementVereist') === 'ja',
    };
    try {
      const r = await maakNieuweKlant(
        deps.db,
        { ...waarden, abonnement: waarden.abonnement as Abonnement },
        uitnodigingOpties(),
      );
      return await toonKoppellink(c, sessie, r.uitnodiging);
    } catch (err) {
      if (!(err instanceof NieuweKlantFout)) throw err;
      c.status(400);
      return c.html(
        nieuweKlantView({
          csrfToken: sessie.csrfToken,
          abonnementen: ABONNEMENTEN,
          waarden,
          foutmelding: err.message,
        }),
      );
    }
  });

  app.post('/admin/klanten/:accountId/koppellink', async (c) => {
    const sessie = laadSessie(c, sessies);
    if (!sessie) return c.redirect('/admin/login', 303);
    const form = await c.req.parseBody();
    if (!csrfConstanteTijdGelijk(getString(form, 'csrf'), sessie.csrfToken)) {
      c.status(403);
      return c.text('CSRF-token ontbreekt of klopt niet.');
    }
    const accountId = c.req.param('accountId');
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
      zetFlash(c, deps, { soort: 'fout', tekst: 'Onbekend account; er is geen koppellink gemaakt.' });
      return c.redirect('/admin/klanten', 303);
    }
    try {
      const uitnodiging = await maakNieuweKoppeluitnodiging(deps.db, accountId, uitnodigingOpties());
      return await toonKoppellink(c, sessie, uitnodiging);
    } catch (err) {
      if (!(err instanceof NieuweKlantFout)) throw err;
      zetFlash(c, deps, { soort: 'fout', tekst: err.message });
      return c.redirect('/admin/klanten', 303);
    }
  });

  return app;
}

// -- hulpjes ---------------------------------------------------------------

function clientSleutel(c: AdminContext, vertrouwProxy: boolean): string {
  // Valt alles weg, dan werkt de blokkade nog als globale rem (één gebruiker).
  return clientIp(c, vertrouwProxy) ?? 'onbekend';
}

function krijgOfMaakPreCsrf(c: AdminContext, deps: AdminDeps): string {
  const bestaand = getCookie(c, CSRF_COOKIE);
  if (bestaand) return bestaand;
  const nieuw = randomBytes(24).toString('base64url');
  setCookie(c, CSRF_COOKIE, nieuw, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'Strict',
    path: '/admin',
    maxAge: 15 * 60,
  });
  return nieuw;
}

/** Zelfde voorstel als het formulier-script: accenten weg, dan maakSlug. */
function slugVoorstel(naam: string): string {
  return maakSlug(naam.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

function laadSessie(c: AdminContext, sessies: SessieStore): Sessie | null {
  const id = getCookie(c, SESSIE_COOKIE);
  return sessies.vind(id ?? null);
}

function csrfConstanteTijdGelijk(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function getString(form: Record<string, unknown>, veld: string): string {
  const w = form[veld];
  if (typeof w === 'string') return w;
  if (Array.isArray(w)) {
    const eerste = w[0];
    return typeof eerste === 'string' ? eerste : '';
  }
  return '';
}

function zetFlash(
  c: AdminContext,
  deps: AdminDeps,
  melding: { soort: 'ok' | 'fout'; tekst: string },
): void {
  setCookie(c, FLASH_COOKIE, `${melding.soort}:${melding.tekst}`, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'Strict',
    path: '/admin',
    maxAge: 30,
  });
}

function flashUitCookie(c: AdminContext):
  | { soort: 'ok' | 'fout'; tekst: string }
  | undefined {
  const w = getCookie(c, FLASH_COOKIE);
  if (!w) return undefined;
  deleteCookie(c, FLASH_COOKIE, { path: '/admin' });
  const [soort, ...rest] = w.split(':');
  const tekst = rest.join(':');
  if (soort !== 'ok' && soort !== 'fout') return undefined;
  return { soort, tekst };
}
