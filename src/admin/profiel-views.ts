import type { Intake, IntakeRonde } from '../config/intake.ts';
import type { Antwoorden } from '../profiel/invoer.ts';
import { ontbrekendeVerplichte } from '../profiel/invoer.ts';
import {
  MAX_INTERNE_AANVULLING,
  MAX_VRAAG,
  type ProfielActie,
  type ProfielBericht,
  type ProfielStand,
} from '../profiel/profielen.ts';
import {
  PROFIEL_CSS,
  datumTekst,
  eersteOpenRonde,
  gesprekHtml,
  rondeFormulier,
  rondeLijst,
  samenvattingHtml,
} from '../profiel/views.ts';

import { adminHeader, h, layout } from './views.ts';

/**
 * Klantprofiel in de admin (SPEC §14.6): beoordelen, vaststellen, terugsturen
 * met een vraag, interne aanvulling, en namens de klant invullen.
 */

type Melding = { soort: 'ok' | 'fout'; tekst: string };

export const PROFIEL_STATUS_TEKST: Record<ProfielActie, string> = {
  invullen: 'Nog niet ingediend.',
  vraag: 'Teruggestuurd naar de klant met een vraag.',
  ingediend: 'Ingediend: wacht op vaststellen door MARKaaS.',
  wijziging: 'Vastgesteld; de klant werkt aan een wijziging.',
  klaar: 'Vastgesteld.',
};

export interface AdminProfielOpties {
  csrfToken: string;
  klantNaam: string;
  slug: string;
  intake: Intake;
  stand: ProfielStand;
  actie: ProfielActie;
  melding?: Melding;
  /** Gesprek bij de open versie en bij de vastgestelde versie (SPEC 0.4). */
  berichtenOpen?: readonly ProfielBericht[];
  berichtenVastgesteld?: readonly ProfielBericht[];
}

function basisVan(slug: string): string {
  return `/admin/klanten/${encodeURIComponent(slug)}/profiel`;
}

export function adminProfielView(o: AdminProfielOpties): string {
  const basis = basisVan(o.slug);
  const { open, vastgesteld } = o.stand;
  const csrf = `<input type="hidden" name="csrf" value="${h(o.csrfToken)}">`;
  const delen: string[] = [`<p><strong>${h(PROFIEL_STATUS_TEKST[o.actie])}</strong></p>`];

  if (open?.status === 'ingediend') {
    const aanvulling = open.interneAanvulling || vastgesteld?.interneAanvulling || '';
    delen.push(`
  <section class="actie-kaart">
    <h3>Ingediende versie ${h(open.versie)} (${h(datumTekst(open.ingediendOp))}, door ${h(open.ingediendDoor ?? '—')})</h3>
    ${samenvattingHtml(o.intake, open.antwoorden)}
  </section>
  ${gesprekHtml(o.berichtenOpen ?? [], 'admin')}
  <section class="actie-kaart">
    <h3>Vaststellen</h3>
    <form method="post" action="${basis}/vaststellen" class="formulier">
      ${csrf}
      <label for="interne_aanvulling">Interne aanvulling (alleen MARKaaS en de skill; nooit zichtbaar voor de klant)</label>
      <textarea id="interne_aanvulling" name="interne_aanvulling" class="kopie" rows="8" maxlength="${MAX_INTERNE_AANVULLING}"
        placeholder="Zoekfilters, extra uitsluitingen, haken en sectoren voor het dashboard">${h(aanvulling)}</textarea>
      <p><button type="submit">Vaststellen</button></p>
    </form>
  </section>
  <section class="actie-kaart">
    <h3>Terugsturen met een vraag</h3>
    <form method="post" action="${basis}/terugsturen" class="formulier">
      ${csrf}
      <label for="vraag">Vraag aan de klant (zichtbaar in het portaal)</label>
      <textarea id="vraag" name="vraag" rows="3" maxlength="${MAX_VRAAG}" required></textarea>
      <p><button type="submit" class="secundair">Terugsturen</button></p>
    </form>
  </section>`);
  } else if (open) {
    const ontbreekt = ontbrekendeVerplichte(o.intake, open.antwoorden);
    delen.push(`
  ${gesprekHtml(o.berichtenOpen ?? [], 'admin')}
  <section class="actie-kaart">
    <h3>Concept, versie ${h(open.versie)}</h3>
    <p class="uitleg">De klant vult dit in het portaal in. U kunt ook namens de klant invullen en indienen.</p>
    ${rondeLijst(basis, o.intake, open.antwoorden, true)}
    ${
      ontbreekt.length === 0
        ? `<form method="post" action="${basis}/indienen">${csrf}
      <input type="hidden" name="revisie" value="${h(open.revisie)}">
      <button type="submit">Indienen namens de klant</button></form>`
        : `<p class="uitleg">Nog ${ontbreekt.length} verplichte ${ontbreekt.length === 1 ? 'vraag' : 'vragen'} open.</p>`
    }
    ${samenvattingHtml(o.intake, open.antwoorden)}
  </section>`);
  } else if (!vastgesteld) {
    const start = eersteOpenRonde(o.intake, {});
    delen.push(`
  <section class="actie-kaart">
    <p>De klant heeft nog niets ingevuld. Voor bestaande klanten kunt u de intake namens de klant invullen.</p>
    <p><a class="knop" href="${basis}/${h(start.id)}">Invullen namens de klant</a></p>
  </section>`);
  }

  if (vastgesteld) {
    delen.push(`
  <section class="actie-kaart">
    <h3>Vastgestelde versie ${h(vastgesteld.versie)} (${h(datumTekst(vastgesteld.vastgesteldOp))}, door ${h(vastgesteld.vastgesteldDoor ?? '—')})</h3>
    ${samenvattingHtml(o.intake, vastgesteld.antwoorden)}
    ${gesprekHtml(o.berichtenVastgesteld ?? [], 'admin')}
    <form method="post" action="${basis}/aanvulling" class="formulier">
      ${csrf}
      <label for="aanvulling_vast">Interne aanvulling (alleen MARKaaS en de skill)</label>
      <textarea id="aanvulling_vast" name="interne_aanvulling" class="kopie" rows="8" maxlength="${MAX_INTERNE_AANVULLING}">${h(
        vastgesteld.interneAanvulling,
      )}</textarea>
      <p><button type="submit" class="secundair">Interne aanvulling bijwerken</button></p>
    </form>
    ${
      open
        ? ''
        : `<form method="post" action="${basis}/wijziging">${csrf}
      <button type="submit" class="secundair">Nieuwe versie maken (namens de klant)</button></form>`
    }
  </section>`);
  }

  return layout(
    `Klantprofiel ${o.klantNaam}`,
    `
${adminHeader(`Klantprofiel ${o.klantNaam}`, o.csrfToken)}
<main>
  <style>${PROFIEL_CSS}</style>
  ${o.melding ? `<p class="melding ${o.melding.soort}">${h(o.melding.tekst)}</p>` : ''}
  ${delen.join('\n')}
  <p><a class="knop secundair" href="/admin/klanten/${encodeURIComponent(o.slug)}">Terug naar de klant</a></p>
</main>`,
  );
}

export interface AdminProfielRondeOpties {
  csrfToken: string;
  klantNaam: string;
  slug: string;
  intake: Intake;
  ronde: IntakeRonde;
  antwoorden: Antwoorden;
  revisie: number;
  accountNamen: readonly string[];
  melding?: Melding;
}

export function adminProfielRondeView(o: AdminProfielRondeOpties): string {
  return layout(
    `${o.ronde.titel} · ${o.klantNaam}`,
    `
${adminHeader(`Klantprofiel ${o.klantNaam} (namens de klant)`, o.csrfToken)}
<main>
  ${o.melding ? `<p class="melding ${o.melding.soort}">${h(o.melding.tekst)}</p>` : ''}
  ${rondeFormulier({
    basis: basisVan(o.slug),
    intake: o.intake,
    ronde: o.ronde,
    antwoorden: o.antwoorden,
    revisie: o.revisie,
    csrfToken: o.csrfToken,
    accountNamen: o.accountNamen,
  })}
</main>`,
  );
}
