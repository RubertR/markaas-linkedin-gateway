import { h } from '../admin/views.ts';
import type { Intake } from '../config/intake.ts';
import { ontbrekendeVerplichte } from '../profiel/invoer.ts';
import type { ProfielActie, ProfielStand } from '../profiel/profielen.ts';
import {
  PROFIEL_CSS,
  datumTekst,
  eersteOpenRonde,
  rondeFormulier,
  rondeLijst,
  samenvattingHtml,
  type RondeFormulierOpties,
} from '../profiel/views.ts';

import { layout, portaalHeader, type Melding } from './views.ts';

/**
 * Portaalpagina's van de klantprofiel-intake (SPEC §14.6): overzicht op
 * /portaal/profiel en één formulier per ronde op /portaal/profiel/<ronde>.
 */

const BASIS = '/portaal/profiel';

interface Gedeeld {
  klantNaam: string;
  csrfToken: string;
  melding?: Melding;
  betalingMislukt?: boolean;
}

function meldingBlok(m?: Melding): string {
  return m ? `<p class="melding ${m.soort}">${h(m.tekst)}</p>` : '';
}

export interface ProfielOverzichtOpties extends Gedeeld {
  intake: Intake;
  stand: ProfielStand;
  actie: ProfielActie;
}

export function profielOverzichtView(o: ProfielOverzichtOpties): string {
  const { open, vastgesteld } = o.stand;
  let inhoud: string;
  if (o.actie === 'ingediend' && open) {
    inhoud = `
  <section class="actie-kaart">
    <h3>Ingediend bij MARKaaS</h3>
    <p>Uw klantprofiel is ingediend op ${h(datumTekst(open.ingediendOp))}. MARKaaS beoordeelt het en laat het
      weten als het is vastgesteld of als er een vraag is.${
        vastgesteld ? ` Tot dan geldt versie ${h(vastgesteld.versie)}.` : ''
      }</p>
  </section>
  ${samenvattingHtml(o.intake, open.antwoorden)}`;
  } else if (o.actie === 'klaar' && vastgesteld) {
    inhoud = `
  <section class="actie-kaart">
    <h3>Uw klantprofiel is vastgesteld</h3>
    <p>Versie ${h(vastgesteld.versie)}, vastgesteld op ${h(datumTekst(vastgesteld.vastgesteldOp))}. MARKaaS zoekt en
      schrijft op basis van dit profiel. Is er iets veranderd in uw aanbod of doelgroep? Vraag dan een wijziging aan.</p>
    <form method="post" action="${BASIS}/wijziging">
      <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
      <button type="submit" class="secundair">Wijziging aanvragen</button>
    </form>
  </section>
  ${samenvattingHtml(o.intake, vastgesteld.antwoorden)}`;
  } else {
    const antwoorden = open?.antwoorden ?? {};
    const ontbreekt = ontbrekendeVerplichte(o.intake, antwoorden);
    const start = eersteOpenRonde(o.intake, antwoorden);
    const vraag = open?.vraagVanMarkaas
      ? `<div class="vraag-markaas" role="status"><strong>Vraag van MARKaaS:</strong> ${h(open.vraagVanMarkaas)}</div>`
      : '';
    const wijziging =
      o.actie === 'wijziging' && vastgesteld
        ? `<p class="uitleg">U werkt aan een nieuwe versie. Tot die is vastgesteld, blijft versie ${h(vastgesteld.versie)} gelden.</p>`
        : '';
    const compleet = Boolean(open) && ontbreekt.length === 0;
    const indienen =
      compleet && open
        ? `<form method="post" action="${BASIS}/indienen">
      <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
      <input type="hidden" name="revisie" value="${h(open.revisie)}">
      <button type="submit">Indienen bij MARKaaS</button>
    </form>`
        : `<p class="uitleg">Nog ${ontbreekt.length} verplichte ${ontbreekt.length === 1 ? 'vraag' : 'vragen'} te gaan; daarna kunt u het profiel indienen.</p>`;
    inhoud = `
  ${vraag}
  <section class="actie-kaart">
    <h3>Zo stemmen we alles af op uw bedrijf</h3>
    <p>In vijf korte rondes vertelt u wat u verkoopt, wie uw beste klanten zijn, wanneer een bedrijf in de markt is en
      wat we in berichten mogen noemen. MARKaaS maakt daar uw eigen klantprofiel en doelgroep (ICP) van. Uw antwoorden
      worden per ronde bewaard; een collega kan verdergaan waar u stopte.</p>
    ${wijziging}
    ${
      compleet
        ? `<p><strong>Alle verplichte vragen zijn beantwoord.</strong> Controleer het overzicht hieronder en dien het profiel
      in bij MARKaaS, of pas eerst nog iets aan.</p>
    <div class="knoppen">${indienen}<p><a class="knop secundair" href="${BASIS}/${h(start.id)}">Wijzigen</a></p></div>`
        : `<p><a class="knop" href="${BASIS}/${h(start.id)}">${open ? 'Verder invullen' : 'Beginnen'}</a></p>`
    }
  </section>
  ${rondeLijst(BASIS, o.intake, antwoorden, true)}
  ${open ? `<h2>Overzicht van uw antwoorden</h2>${samenvattingHtml(o.intake, antwoorden)}` : ''}
  <section class="actie-kaart">${indienen}</section>`;
  }
  return layout(
    'Klantprofiel',
    `
${portaalHeader(o.klantNaam, o.csrfToken, 'profiel', o.betalingMislukt, o.actie)}
<main>
  <style>${PROFIEL_CSS}</style>
  ${meldingBlok(o.melding)}
  <h2>Uw klantprofiel</h2>
  ${inhoud}
</main>`,
  );
}

export interface ProfielRondeOpties extends Gedeeld, Omit<RondeFormulierOpties, 'basis' | 'csrfToken'> {
  actie: ProfielActie;
  vraagVanMarkaas: string | null;
}

export function profielRondeView(o: ProfielRondeOpties): string {
  return layout(
    o.ronde.titel,
    `
${portaalHeader(o.klantNaam, o.csrfToken, 'profiel', o.betalingMislukt, o.actie)}
<main>
  ${meldingBlok(o.melding)}
  ${o.vraagVanMarkaas ? `<div class="vraag-markaas" role="status"><strong>Vraag van MARKaaS:</strong> ${h(o.vraagVanMarkaas)}</div>` : ''}
  ${rondeFormulier({ ...o, basis: BASIS })}
</main>`,
  );
}
