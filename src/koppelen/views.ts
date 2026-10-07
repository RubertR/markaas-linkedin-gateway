import { h } from '../admin/views.ts';
import type { JuridischDocument } from '../config/juridisch.ts';

/**
 * Publieke pagina's voor de accounteigenaar (SPEC §14.2). Server-side HTML,
 * geen JavaScript, in gewone taal. Zelfde eenvoudige stijl als de admin, maar
 * rustiger en gericht op één taak per pagina.
 */

const CSS = `
*,*::before,*::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  background: #f4f5f7;
  color: #1b1f23;
  line-height: 1.55;
  padding: 1.5rem 1rem 3rem;
}
main { max-width: 38rem; margin: 0 auto; }
.merk { font-weight: 700; letter-spacing: 0.02em; color: #0b63b7; margin: 0 0 1rem; }
.kaart { background: #fff; border: 1px solid #e1e5ea; border-radius: 8px;
         padding: 1.25rem 1.25rem 1rem; margin: 0 0 1rem; }
h1 { font-size: 1.45rem; line-height: 1.25; margin: 0 0 0.75rem; }
h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
p { margin: 0 0 0.75rem; }
ul { margin: 0 0 0.75rem; padding-left: 1.2rem; }
li { margin: 0 0 0.35rem; }
.klein { font-size: 0.9rem; color: #555; }
.melding { padding: 0.7rem 0.9rem; border-radius: 6px; margin: 0 0 1rem; }
.melding.fout { background: #fdebe8; border: 1px solid #b23c2d; }
.melding.ok { background: #e4f6ea; border: 1px solid #4b9f5e; }
label.veld { display: block; font-weight: 600; margin: 0 0 0.25rem; }
input[type="text"], input[type="email"] {
  width: 100%; padding: 0.65rem; font-size: 1rem;
  border: 1px solid #c4c9cf; border-radius: 6px; margin: 0 0 0.9rem;
}
.vinkje { display: flex; gap: 0.6rem; align-items: flex-start; margin: 0 0 0.8rem; }
.vinkje input { margin-top: 0.3rem; width: 1.15rem; height: 1.15rem; flex: none; }
button {
  background: #0b63b7; color: #fff; border: 0; border-radius: 6px;
  padding: 0.8rem 1.2rem; font-size: 1rem; min-height: 44px; cursor: pointer; width: 100%;
}
a { color: #0b63b7; }
`;

function layout(titel: string, inhoud: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <title>${h(titel)} — MARKaaS</title>
  <style>${CSS}</style>
</head>
<body>
<main>
  <p class="merk">MARKaaS</p>
${inhoud}
</main>
</body>
</html>`;
}

export interface KoppelLimieten {
  verzoekenPerDag: number;
  verzoekenPerWeek: number;
  berichtenPerDag: number;
  berichtenPerWeek: number;
  /** Bijv. 50 (procent) bij een start_factor van 0.5. */
  startPercentage: number;
}

export interface KoppelPaginaOpties {
  token: string;
  csrf: string;
  /** Double-submit-waarde, gelijk aan de cookie `koppel_csrf`. */
  csrfCookie: string;
  klantNaam: string;
  naam: string;
  email: string;
  limieten: KoppelLimieten;
  voorwaarden: JuridischDocument;
  verwerkersovereenkomst: JuridischDocument;
  /** Eerder aangevinkt (bij een foutmelding blijven ze staan). */
  aangevinkt?: { eigenaar: boolean; toestemming: boolean; voorwaarden: boolean };
  foutmelding?: string;
}

function documentTekst(naam: string, doc: JuridischDocument): string {
  const label = `${naam} (versie ${doc.versie})`;
  return doc.url
    ? `<a href="${h(doc.url)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>`
    : h(label);
}

/** Lege url: geen link, maar de melding dat MARKaaS het document meestuurt. */
function meegestuurd(naam: string, doc: JuridischDocument): string {
  if (doc.url) return '';
  return `<p class="klein">${h(naam)} (versie ${h(doc.versie)}): wordt meegestuurd door MARKaaS.</p>`;
}

function vinkje(naam: string, tekst: string, aan: boolean): string {
  return `
  <label class="vinkje">
    <input type="checkbox" name="${h(naam)}" value="ja" required${aan ? ' checked' : ''}>
    <span>${tekst}</span>
  </label>`;
}

export function koppelPaginaView(o: KoppelPaginaOpties): string {
  const l = o.limieten;
  const v = o.aangevinkt ?? { eigenaar: false, toestemming: false, voorwaarden: false };
  const inhoud = `
  <div class="kaart">
    <h1>LinkedIn-account koppelen</h1>
    <p>MARKaaS vraagt u om uw LinkedIn-account te koppelen aan de MARKaaS-gateway, voor
       <strong>${h(o.klantNaam)}</strong>. Lees hieronder wat dat betekent.</p>
  </div>

  <div class="kaart">
    <h2>Wat de gateway doet</h2>
    <ul>
      <li>MARKaaS zoekt via uw account naar passende contactpersonen en zet
          connectieverzoeken en berichten voor u klaar.</li>
      <li><strong>Elk verzoek en elk bericht wordt eerst door een mens gelezen en goedgekeurd</strong>
          voordat het verstuurd wordt. Er gaat niets automatisch de deur uit.</li>
      <li>Er gelden vaste limieten per dag en per week, bijvoorbeeld hooguit
          ${h(l.verzoekenPerDag)} per dag en ${h(l.verzoekenPerWeek)} per week voor connectieverzoeken
          en ${h(l.berichtenPerDag)} per dag en ${h(l.berichtenPerWeek)} per week voor berichten.
          Alleen op werkdagen, tijdens kantooruren, met pauzes ertussen.</li>
      <li>Een nieuw account start met een opbouwperiode: de eerste 7 dagen werkt de gateway op
          ${h(l.startPercentage)}% van die limieten, daarna loopt dat rustig op.</li>
      <li>MARKaaS ziet uw LinkedIn-wachtwoord niet. U logt in op de beveiligde pagina van
          Unipile, de partij die de verbinding met LinkedIn verzorgt.</li>
    </ul>
    <p class="klein">LinkedIn staat geautomatiseerd gebruik niet uitdrukkelijk toe; ondanks de
       voorzichtige limieten kan LinkedIn een account tijdelijk beperken.</p>
  </div>

  <div class="kaart">
    <h2>Uw toestemming</h2>
    ${o.foutmelding ? `<p class="melding fout">${h(o.foutmelding)}</p>` : ''}
    <form method="post" action="/koppelen/${h(o.token)}">
      <input type="hidden" name="csrf" value="${h(o.csrf)}">
      <input type="hidden" name="csrf_cookie" value="${h(o.csrfCookie)}">
      <label class="veld" for="naam">Uw naam</label>
      <input id="naam" name="naam" type="text" required maxlength="200"
             autocomplete="name" value="${h(o.naam)}">
      <label class="veld" for="email">Uw e-mailadres</label>
      <input id="email" name="email" type="email" required maxlength="254"
             autocomplete="email" value="${h(o.email)}">
      ${vinkje(
        'eigenaar',
        'Ik ben eigenaar van dit LinkedIn-account of handel met toestemming van de eigenaar.',
        v.eigenaar,
      )}
      ${vinkje(
        'toestemming',
        'Ik geef toestemming om dit account via de gateway te gebruiken binnen de vastgelegde limieten.',
        v.toestemming,
      )}
      ${vinkje(
        'voorwaarden',
        `Ik heb de ${documentTekst('voorwaarden', o.voorwaarden)} en de ${documentTekst(
          'verwerkersovereenkomst',
          o.verwerkersovereenkomst,
        )} gelezen.`,
        v.voorwaarden,
      )}
      ${meegestuurd('Voorwaarden', o.voorwaarden)}
      ${meegestuurd('Verwerkersovereenkomst', o.verwerkersovereenkomst)}
      <button type="submit">Akkoord, ga naar LinkedIn-koppeling</button>
    </form>
    <p class="klein" style="margin-top:0.75rem">Na de knop gaat u naar de beveiligde pagina van
       Unipile om in te loggen bij LinkedIn. Daarna komt u hier terug.</p>
  </div>`;
  return layout('Account koppelen', inhoud);
}

export function ongeldigView(): string {
  return layout(
    'Link niet geldig',
    `
  <div class="kaart">
    <h1>Deze link is niet meer geldig</h1>
    <p>Deze koppellink werkt niet meer. Vraag MARKaaS om een nieuwe.</p>
  </div>`,
  );
}

export function verlopenFormulierView(): string {
  return layout(
    'Formulier verlopen',
    `
  <div class="kaart">
    <h1>Formulier verlopen</h1>
    <p>Het formulier kon niet worden gecontroleerd. Open de link uit de mail van MARKaaS opnieuw
       en probeer het nog een keer.</p>
  </div>`,
  );
}

export function unipileFoutView(): string {
  return layout(
    'Even geduld',
    `
  <div class="kaart">
    <h1>Het koppelen lukt nu even niet</h1>
    <p>Uw toestemming is vastgelegd, maar de beveiligde inlogpagina kon op dit moment niet worden
       geopend. Probeer het over een paar minuten opnieuw via dezelfde link.</p>
    <p class="klein">Blijft dit gebeuren? Laat het MARKaaS weten.</p>
  </div>`,
  );
}

export function klaarView(): string {
  return layout(
    'Gekoppeld',
    `
  <div class="kaart">
    <h1>Uw account is gekoppeld</h1>
    <p>Dank u wel. Uw LinkedIn-account is gekoppeld aan de MARKaaS-gateway. U hoeft verder niets
       te doen; MARKaaS neemt contact met u op over de volgende stappen.</p>
    <p class="klein">Het kan een paar minuten duren voordat de koppeling bij MARKaaS zichtbaar is.
       U kunt dit venster sluiten.</p>
  </div>`,
  );
}

export function mislukView(): string {
  return layout(
    'Koppelen niet gelukt',
    `
  <div class="kaart">
    <h1>Het koppelen is niet gelukt</h1>
    <p>Er ging iets mis bij het inloggen bij LinkedIn, of het inloggen is afgebroken. Er is niets
       gekoppeld.</p>
    <p>Wat nu: vraag MARKaaS om een nieuwe koppellink en probeer het daarmee nog een keer.
       De oude link werkt niet meer.</p>
  </div>`,
  );
}
