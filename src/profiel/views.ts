import { formatteerAmsterdam } from '../admin/datum.ts';
import { h } from '../admin/views.ts';
import type { Intake, IntakeRonde, IntakeVraag } from '../config/intake.ts';

import { ANDERS_WAARDE, isBeantwoord, samenvatting, type Antwoord, type Antwoorden } from './invoer.ts';

/**
 * HTML-bouwstenen voor de klantprofiel-intake (SPEC §14.6), gedeeld door het
 * portaal (klant) en de admin (MARKaaS vult namens de klant in). Alleen
 * fragmenten; de pagina's eromheen komen uit portaal/views.ts en admin/views.ts.
 * Alle invoer wordt ge-escaped met `h`.
 */

export const PROFIEL_CSS = `
.intake fieldset { border: 0; padding: 0; margin: 0 0 1.2rem; }
.intake legend { font-weight: 600; margin: 0 0 0.4rem; padding: 0; }
.intake .opties { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.3rem 1rem; }
.intake label.optie { display: flex; gap: 0.5rem; align-items: flex-start; font-weight: 400; min-height: 44px; padding: 0.4rem 0; }
.intake label.optie input { margin-top: 0.2rem; width: 1.1rem; height: 1.1rem; flex: none; }
.intake textarea { width: 100%; min-height: 5rem; font: inherit; padding: 0.5rem; border: 1px solid #c4c9cf; border-radius: 4px; }
.intake input[type="text"] { width: 100%; }
.intake .anders { margin-top: 0.3rem; }
.intake .verplicht { color: #8a2a1f; font-weight: 400; font-size: 0.9rem; }
.intake .claim { display: grid; gap: 0.3rem; margin: 0 0 0.8rem; }
.intake .knoppen { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: space-between; }
.voortgang { color: #555; font-size: 0.95rem; margin: 0 0 0.6rem; }
.rondes { list-style: none; padding: 0; margin: 0 0 1rem; }
.rondes li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; align-items: center;
             background: #fff; border: 1px solid #e1e5ea; border-radius: 6px; padding: 0.6rem 0.8rem; margin: 0 0 0.4rem; }
.samenvatting h3 { margin: 1rem 0 0.4rem; font-size: 1rem; }
.samenvatting dl { display: grid; grid-template-columns: minmax(12rem, 1fr) 2fr; gap: 0.3rem 1rem; margin: 0; }
.samenvatting dt { color: #333; }
.samenvatting dd { margin: 0; white-space: pre-wrap; }
.samenvatting .leeg-antwoord { color: #777; }
.vraag-markaas { background: #fff4d6; border: 1px solid #c99a00; border-radius: 4px; padding: 0.6rem 0.8rem; margin: 0 0 1rem; }
@media (max-width: 40rem) { .samenvatting dl { grid-template-columns: 1fr; } }
`;

export interface RondeFormulierOpties {
  /** Basis-URL zonder slash aan het eind, bijv. /portaal/profiel of /admin/klanten/tag/profiel. */
  basis: string;
  intake: Intake;
  ronde: IntakeRonde;
  antwoorden: Antwoorden;
  revisie: number;
  csrfToken: string;
  /** Namen van de gekoppelde LinkedIn-accounts (geheugensteun bij de afzendervraag). */
  accountNamen: readonly string[];
}

export function rondeFormulier(o: RondeFormulierOpties): string {
  const index = o.intake.rondes.findIndex((r) => r.id === o.ronde.id);
  const laatste = index === o.intake.rondes.length - 1;
  return `
<style>${PROFIEL_CSS}</style>
<p class="voortgang">Ronde ${index + 1} van ${o.intake.rondes.length}</p>
<h2>${h(o.ronde.titel)}</h2>
${o.ronde.uitleg ? `<p class="uitleg">${h(o.ronde.uitleg)}</p>` : ''}
<form method="post" action="${h(o.basis)}/${h(o.ronde.id)}" class="intake actie-kaart">
  <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
  <input type="hidden" name="revisie" value="${h(o.revisie)}">
  ${o.ronde.vragen.map((v) => vraagHtml(v, o.antwoorden[v.id], o.accountNamen)).join('\n')}
  <div class="knoppen">
    ${
      index > 0
        ? '<button type="submit" name="richting" value="vorige" class="secundair">Opslaan en vorige</button>'
        : `<a class="knop secundair" href="${h(o.basis)}">Naar het overzicht</a>`
    }
    <button type="submit" name="richting" value="volgende">${laatste ? 'Opslaan en naar het overzicht' : 'Opslaan en verder'}</button>
  </div>
</form>`;
}

function vraagHtml(v: IntakeVraag, a: Antwoord | undefined, accountNamen: readonly string[]): string {
  const naam = `v_${v.id}`;
  const verplicht = v.verplicht ? ' <span class="verplicht">(verplicht)</span>' : '';
  switch (v.type) {
    case 'tekst': {
      const accounts =
        v.toonAccounts && accountNamen.length > 0
          ? `<p class="uitleg">Gekoppelde LinkedIn-accounts: ${accountNamen.map(h).join(', ')}.</p>`
          : '';
      return `<fieldset>
    <legend><label for="${naam}">${h(v.label)}${verplicht}</label></legend>
    ${accounts}
    <textarea id="${naam}" name="${naam}" maxlength="1000">${h(a?.tekst ?? '')}</textarea>
  </fieldset>`;
    }
    case 'keuze':
    case 'keuzes': {
      const meer = v.type === 'keuzes';
      const gekozen = new Set(a?.keuzes ?? []);
      const opties = v.opties
        .map(
          (optie, i) => `<label class="optie"><input type="${meer ? 'checkbox' : 'radio'}" name="${naam}" value="${h(optie)}" id="${naam}_${i}"${
            gekozen.has(optie) ? ' checked' : ''
          }> <span>${h(optie)}</span></label>`,
        )
        .join('\n      ');
      const anders = v.anders
        ? meer
          ? `<div class="anders"><label for="${naam}_anders">Anders, namelijk</label>
      <input type="text" id="${naam}_anders" name="${naam}_anders" maxlength="300" value="${h(a?.anders ?? '')}"></div>`
          : `<label class="optie"><input type="radio" name="${naam}" value="${ANDERS_WAARDE}" id="${naam}_anders_keuze"${
              a?.anders ? ' checked' : ''
            }> <span>Anders, namelijk</span></label>
      <div class="anders"><label for="${naam}_anders" class="uitleg">Vul in als u "Anders" kiest</label>
      <input type="text" id="${naam}_anders" name="${naam}_anders" maxlength="300" value="${h(a?.anders ?? '')}"></div>`
        : '';
      return `<fieldset>
    <legend>${h(v.label)}${verplicht}${meer ? ' <span class="uitleg">(meerdere mogelijk)</span>' : ''}</legend>
    <div class="opties">
      ${opties}
    </div>
    ${anders}
  </fieldset>`;
    }
    case 'claims': {
      const bestaand = a?.claims ?? [];
      const velden = Array.from({ length: v.maxClaims }, (_, i) => {
        const n = i + 1;
        const c = bestaand[i];
        return `<div class="claim">
      <label for="${naam}_tekst_${n}">Claim ${n}</label>
      <input type="text" id="${naam}_tekst_${n}" name="${naam}_tekst_${n}" maxlength="300" value="${h(c?.tekst ?? '')}">
      <label class="optie"><input type="checkbox" name="${naam}_ok_${n}" value="ja"${c?.bevestigd ? ' checked' : ''}> <span>Dit klopt en mag in berichten gebruikt worden</span></label>
    </div>`;
      }).join('\n    ');
      return `<fieldset>
    <legend>${h(v.label)}${verplicht}</legend>
    <p class="uitleg">We noemen alleen wat u hier bevestigt. Laat leeg wat niet mag.</p>
    ${velden}
  </fieldset>`;
    }
  }
}

/** Samenvatting in gewone taal; leeg antwoord = "nog niet ingevuld". */
export function samenvattingHtml(intake: Intake, antwoorden: Antwoorden): string {
  return `<div class="samenvatting">${samenvatting(intake, antwoorden)
    .map(
      (r) => `
  <h3>${h(r.titel)}</h3>
  <dl>${r.regels
    .map(
      (regel) =>
        `<dt>${h(regel.label)}</dt><dd>${regel.waarde ? h(regel.waarde) : '<span class="leeg-antwoord">nog niet ingevuld</span>'}</dd>`,
    )
    .join('')}</dl>`,
    )
    .join('')}</div>`;
}

/** Lijst van rondes met voortgang en een link per ronde. */
export function rondeLijst(basis: string, intake: Intake, antwoorden: Antwoorden, bewerkbaar: boolean): string {
  return `<ol class="rondes">${intake.rondes
    .map((r) => {
      const beantwoord = r.vragen.filter((v) => isBeantwoord(v, antwoorden[v.id])).length;
      return `<li><span><strong>${h(r.titel)}</strong> · ${beantwoord} van ${r.vragen.length} beantwoord</span>${
        bewerkbaar ? `<a class="knop secundair" href="${h(basis)}/${h(r.id)}">${beantwoord > 0 ? 'Wijzigen' : 'Invullen'}</a>` : ''
      }</li>`;
    })
    .join('')}</ol>`;
}

/** Eerste ronde met een onbeantwoorde verplichte vraag, anders de eerste ronde. */
export function eersteOpenRonde(intake: Intake, antwoorden: Antwoorden): IntakeRonde {
  return (
    intake.rondes.find((r) => r.vragen.some((v) => v.verplicht && !isBeantwoord(v, antwoorden[v.id]))) ??
    intake.rondes[0]!
  );
}

export function datumTekst(d: Date | null): string {
  return d ? formatteerAmsterdam(d) : '—';
}
