import { Hono, type Context } from 'hono';

import { aantalGekoppeld, betalingMisluktVoorKlant, vindAbonnement } from '../abonnement/abonnementen.ts';
import { beschrijfAbonnement } from '../abonnement/weergave.ts';
import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import { conceptenVoorKlant } from '../portaal/dienst.ts';
import { profielOverzichtView, profielRondeView } from '../portaal/profiel-pagina.ts';
import { resultatenVoorKlant } from '../portaal/resultaten.ts';
import { abonnementView, conceptenView, resultatenView } from '../portaal/views.ts';
import { berichtenVoorProfiel, profielActie, profielStand, type ProfielActie } from '../profiel/profielen.ts';

import { h } from './views.ts';

/**
 * "Bekijk als klant" (SPEC §14.7): de portaalpagina's van één klant, alleen
 * lezen, voor de beheerder. Er zijn hier uitsluitend GET-routes; elke POST
 * onder /als-klant geeft 404. De HTML van het portaal wordt hergebruikt en
 * daarna onschadelijk gemaakt: formulieren zonder action, alle knoppen en
 * velden uitgeschakeld, links naar de voorbeeldversie. Er wordt niets in de
 * database geschreven (geen sessie, geen login, geen flash).
 */

export interface AlsKlantDeps {
  db: Backend;
  limieten: Limieten;
  klok: Klok;
  intake?: Intake;
  stripeIngericht?: boolean;
  proefperiodeDagen?: number;
}

export interface VoorbeeldKlant {
  id: string;
  naam: string;
  slug: string;
  abonnementVereist: boolean;
}

/** Maakt portaal-HTML alleen-lezen en zet de voorbeeldbalk erboven. */
export function maakVoorbeeld(html: string, klant: Pick<VoorbeeldKlant, 'naam' | 'slug'>): string {
  const slug = encodeURIComponent(klant.slug);
  const basis = `/admin/klanten/${slug}/als-klant`;
  const balk = `<div role="status" style="position: sticky; top: 0; z-index: 10; margin: -1rem -1rem 1rem; padding: 0.7rem 1rem; background: #1b1f23; color: #fff; display: flex; flex-wrap: wrap; gap: 0.6rem; justify-content: space-between; align-items: center">
  <span><strong>Voorbeeld:</strong> zo ziet ${h(klant.naam)} het portaal. U kunt hier niets wijzigen.</span>
  <a href="/admin/klanten/${slug}" style="color: #fff; font-weight: 600">Terug naar de klant</a>
</div>`;
  return html
    .replace(/<body>/, `<body>\n${balk}`)
    .replace(/href="\/portaal\//g, `href="${basis}/`)
    .replace(/<form\b[^>]*>/g, '<form onsubmit="return false">')
    .replace(/<button\b/g, '<button disabled')
    .replace(/<input\b/g, '<input disabled')
    .replace(/<textarea\b/g, '<textarea disabled')
    .replace(/<select\b/g, '<select disabled');
}

/**
 * Registreert de GET-routes onder /admin/klanten/:slug/als-klant. `toegang`
 * controleert de admin-sessie en zoekt de klant; null = de response die al
 * gegeven is (login of 404).
 */
export function registreerAlsKlant<E extends { Variables: Record<string, unknown> }>(
  app: Hono<E>,
  deps: AlsKlantDeps,
  toegang: (c: Context<E>) => Promise<VoorbeeldKlant | Response>,
): void {
  const pad = '/admin/klanten/:slug/als-klant';

  async function gedeeld(klant: VoorbeeldKlant): Promise<{
    klantNaam: string;
    csrfToken: string;
    betalingMislukt: boolean;
    profielActie?: ProfielActie;
  }> {
    const actie = deps.intake ? profielActie(await profielStand(deps.db, klant.id)) : undefined;
    return {
      klantNaam: klant.naam,
      csrfToken: '',
      betalingMislukt: await betalingMisluktVoorKlant(deps.db, klant.id),
      ...(actie ? { profielActie: actie } : {}),
    };
  }

  function toon(c: Context<E>, klant: VoorbeeldKlant, html: string): Response {
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    return c.html(maakVoorbeeld(html, klant)) as Response;
  }

  app.get(pad, (c) => c.redirect(`/admin/klanten/${encodeURIComponent(c.req.param('slug') ?? '')}/als-klant/`, 301));

  app.get(`${pad}/`, async (c) => {
    const klant = await toegang(c);
    if (klant instanceof Response) return klant;
    const concepten = await conceptenVoorKlant(deps.db, klant.id, { limieten: deps.limieten, klok: deps.klok });
    return toon(c, klant, conceptenView({ ...(await gedeeld(klant)), concepten }));
  });

  app.get(`${pad}/resultaten`, async (c) => {
    const klant = await toegang(c);
    if (klant instanceof Response) return klant;
    const accounts = await resultatenVoorKlant(deps.db, klant.id, deps.klok);
    return toon(c, klant, resultatenView({ ...(await gedeeld(klant)), accounts }));
  });

  app.get(`${pad}/abonnement`, async (c) => {
    const klant = await toegang(c);
    if (klant instanceof Response) return klant;
    return toon(
      c,
      klant,
      abonnementView({
        ...(await gedeeld(klant)),
        weergave: beschrijfAbonnement(klant.abonnementVereist, await vindAbonnement(deps.db, klant.id)),
        aantalAccounts: await aantalGekoppeld(deps.db, klant.id),
        stripeIngericht: deps.stripeIngericht ?? false,
        proefperiodeDagen: deps.proefperiodeDagen ?? 0,
      }),
    );
  });

  if (!deps.intake) return;
  const intake = deps.intake;

  app.get(`${pad}/profiel`, async (c) => {
    const klant = await toegang(c);
    if (klant instanceof Response) return klant;
    const stand = await profielStand(deps.db, klant.id);
    const getoond = stand.open ?? stand.vastgesteld;
    return toon(
      c,
      klant,
      profielOverzichtView({
        ...(await gedeeld(klant)),
        intake,
        stand,
        actie: profielActie(stand),
        ...(getoond ? { berichten: await berichtenVoorProfiel(deps.db, klant.id, getoond.id) } : {}),
      }),
    );
  });

  app.get(`${pad}/profiel/:ronde`, async (c) => {
    const klant = await toegang(c);
    if (klant instanceof Response) return klant;
    const ronde = intake.rondes.find((r) => r.id === c.req.param('ronde'));
    if (!ronde) {
      c.status(404);
      return c.text('Deze ronde van het klantprofiel bestaat niet.');
    }
    const stand = await profielStand(deps.db, klant.id);
    const actie = profielActie(stand);
    // Zoals in het portaal: ingediend of vastgesteld = geen formulier.
    if (actie === 'ingediend' || actie === 'klaar') {
      return c.redirect(`/admin/klanten/${encodeURIComponent(klant.slug)}/als-klant/profiel`, 303);
    }
    const namen = await deps.db.query<{ eigenaar_naam: string }>(
      'select eigenaar_naam from accounts where client_id = $1 order by eigenaar_naam',
      [klant.id],
    );
    return toon(
      c,
      klant,
      profielRondeView({
        ...(await gedeeld(klant)),
        intake,
        ronde,
        antwoorden: stand.open?.antwoorden ?? {},
        revisie: stand.open?.revisie ?? 0,
        accountNamen: namen.map((n) => n.eigenaar_naam),
        actie,
        vraagVanMarkaas: stand.open?.vraagVanMarkaas ?? null,
      }),
    );
  });
}
