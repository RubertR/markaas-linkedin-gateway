import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';

import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';

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
import { loginView, overzichtView } from './views.ts';

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

  return app;
}

// -- hulpjes ---------------------------------------------------------------

function clientSleutel(c: AdminContext, vertrouwProxy: boolean): string {
  if (vertrouwProxy) {
    // Railway's edge-proxy voegt het echte client-IP achteraan `X-Forwarded-For`
    // toe; eerdere items kan de client zelf meesturen. Daarom het laatste item.
    const doorgestuurd = c.req
      .header('x-forwarded-for')
      ?.split(',')
      .map((d) => d.trim())
      .filter((d) => d !== '');
    const laatste = doorgestuurd?.[doorgestuurd.length - 1];
    if (laatste) return laatste;
    const echt = c.req.header('x-real-ip')?.trim();
    if (echt) return echt;
  } else {
    try {
      const adres = getConnInfo(c).remote.address;
      if (adres) return adres;
    } catch {
      /* geen Node-socket (bijv. app.request in tests) */
    }
  }
  // Valt alles weg, dan werkt de blokkade nog als globale rem (één gebruiker).
  return 'onbekend';
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
