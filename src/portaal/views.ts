import { datumTekst, type AbonnementWeergave } from '../abonnement/weergave.ts';
import { formatteerAmsterdam } from '../admin/datum.ts';
import type { DraftWeergave } from '../admin/dienst.ts';
import { BASIS_CSS, h } from '../admin/views.ts';

import { MINIMALE_WACHTWOORDLENGTE } from './gebruikers.ts';
import { kanOpnieuwKoppelen, type AccountResultaat, type AccountStand } from './resultaten.ts';

/**
 * Server-side HTML voor het klantportaal (SPEC §14.3). Zelfde opmaak als de
 * goedkeuringspagina van de admin, maar in gewone taal voor een salesmanager:
 * geen technische id's, budgetten of skillnamen.
 */

const PORTAAL_CSS = `
.klantnaam { color: #555; font-size: 0.95rem; }
.tekst { white-space: pre-wrap; background: #fafbfc; border: 1px solid #e1e5ea;
         border-radius: 4px; padding: 0.6rem; margin: 0 0 0.6rem; }
table.weken { width: 100%; border-collapse: collapse; margin: 0.4rem 0 0; }
table.weken th, table.weken td { text-align: right; padding: 0.3rem 0.5rem;
                                 border-bottom: 1px solid #eef0f3; }
table.weken th:first-child, table.weken td:first-child { text-align: left; }
table.weken tr.totaal td { font-weight: 600; border-top: 2px solid #c4c9cf; }
.stand { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.85rem; }
.stand.goed { background: #e4f6ea; color: #1d5e2f; }
.stand.let-op { background: #fff4d6; color: #6b4b00; }
.stand.actie { background: #fdebe8; color: #8a2a1f; }
.alles { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0 0 1rem; }
.alles button { background: #197a3d; }
.waarschuwing { max-width: 60rem; margin: 0 auto 1rem; padding: 0.6rem 0.8rem; border-radius: 4px;
                background: #fff4d6; border: 1px solid #c99a00; color: #4a3500; }
.waarschuwing a { color: inherit; font-weight: 600; }
dl.abonnement { display: grid; grid-template-columns: 12rem 1fr; gap: 0.3rem 0.8rem; margin: 0.6rem 0; }
dl.abonnement dt { font-weight: 600; color: #333; }
dl.abonnement dd { margin: 0; }
`;

function layout(titel: string, inhoud: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${h(titel)} — MARKaaS klantportaal</title>
  <style>${BASIS_CSS}${PORTAAL_CSS}</style>
</head>
<body>
${inhoud}
</body>
</html>`;
}

export type Melding = { soort: 'ok' | 'fout'; tekst: string };

function meldingBlok(m?: Melding): string {
  return m ? `<p class="melding ${m.soort}">${h(m.tekst)}</p>` : '';
}

export type PortaalPagina = 'concepten' | 'resultaten' | 'abonnement';

/** Gedeelde velden van elke ingelogde portaalpagina. */
export interface PortaalPaginaOpties {
  klantNaam: string;
  csrfToken: string;
  melding?: Melding;
  /** Waarschuwingsbalk bij een mislukte betaling (Stripe-status past_due). */
  betalingMislukt?: boolean;
}

const WAARSCHUWING_PAST_DUE = `<div class="waarschuwing" role="alert">De laatste betaling van uw abonnement is mislukt.
  Werk uw betaalgegevens bij via <a href="/portaal/abonnement">Abonnement</a>; anders stopt het versturen.</div>`;

function portaalHeader(
  klantNaam: string,
  csrfToken: string,
  actief: PortaalPagina,
  betalingMislukt = false,
): string {
  const knop = (pad: string, label: string, naam: typeof actief) =>
    `<a class="knop${actief === naam ? '' : ' secundair'}" href="${pad}"${
      actief === naam ? ' aria-current="page"' : ''
    }>${label}</a>`;
  return `
<header>
  <div>
    <h1>MARKaaS klantportaal</h1>
    <div class="klantnaam">${h(klantNaam)}</div>
  </div>
  <nav>
    ${knop('/portaal/', 'Concepten', 'concepten')}
    ${knop('/portaal/resultaten', 'Resultaten', 'resultaten')}
    ${knop('/portaal/abonnement', 'Abonnement', 'abonnement')}
    <form method="post" action="/portaal/logout">
      <input type="hidden" name="csrf" value="${h(csrfToken)}">
      <button type="submit" class="secundair">Uitloggen</button>
    </form>
  </nav>
</header>${betalingMislukt ? `\n${WAARSCHUWING_PAST_DUE}` : ''}`;
}

// -- login en uitnodiging --------------------------------------------------

export interface LoginViewOpties {
  csrfToken: string;
  email?: string;
  foutmelding?: string;
  blokkadeSeconden?: number;
}

export function loginView(o: LoginViewOpties): string {
  return layout(
    'Inloggen',
    `
<main>
  <header><h1>MARKaaS klantportaal</h1></header>
  ${o.foutmelding ? `<p class="melding fout">${h(o.foutmelding)}</p>` : ''}
  ${
    o.blokkadeSeconden
      ? `<p class="melding fout">Te veel mislukte pogingen. Probeer het over ${h(
          Math.ceil(o.blokkadeSeconden / 60),
        )} minuten opnieuw.</p>`
      : ''
  }
  <form method="post" action="/portaal/login" class="formulier actie-kaart">
    <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
    <label for="email">E-mailadres</label>
    <input id="email" name="email" type="email" required autocomplete="username" value="${h(o.email ?? '')}" autofocus>
    <label for="wachtwoord">Wachtwoord</label>
    <input id="wachtwoord" name="wachtwoord" type="password" required autocomplete="current-password">
    <p><button type="submit">Inloggen</button></p>
    <p class="uitleg">Wachtwoord vergeten? Vraag MARKaaS om een nieuwe link.</p>
  </form>
</main>`,
  );
}

export interface WachtwoordKiezenViewOpties {
  token: string;
  csrfToken: string;
  naam: string;
  email: string;
  klantNaam: string;
  foutmelding?: string;
}

export function wachtwoordKiezenView(o: WachtwoordKiezenViewOpties): string {
  return layout(
    'Wachtwoord kiezen',
    `
<main>
  <header><h1>MARKaaS klantportaal</h1></header>
  <section class="actie-kaart">
    <h3>Welkom, ${h(o.naam)}</h3>
    <p>U bent uitgenodigd voor het klantportaal van ${h(o.klantNaam)}. Hier keurt u de
      LinkedIn-berichten goed die MARKaaS voor uw accounts heeft voorbereid, en ziet u de resultaten.
      Er wordt niets verstuurd zonder goedkeuring.</p>
    <p>Kies een wachtwoord van minimaal ${MINIMALE_WACHTWOORDLENGTE} tekens. U logt in met
      <strong>${h(o.email)}</strong>.</p>
  </section>
  ${o.foutmelding ? `<p class="melding fout">${h(o.foutmelding)}</p>` : ''}
  <form method="post" action="/portaal/uitnodiging/${h(o.token)}" class="formulier actie-kaart">
    <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
    <input type="email" name="email" value="${h(o.email)}" autocomplete="username" hidden readonly>
    <label for="wachtwoord">Nieuw wachtwoord</label>
    <input id="wachtwoord" name="wachtwoord" type="password" required minlength="${MINIMALE_WACHTWOORDLENGTE}" autocomplete="new-password">
    <label for="herhaling">Herhaal het wachtwoord</label>
    <input id="herhaling" name="herhaling" type="password" required minlength="${MINIMALE_WACHTWOORDLENGTE}" autocomplete="new-password">
    <p><button type="submit">Wachtwoord opslaan en inloggen</button></p>
  </form>
</main>`,
  );
}

export function ongeldigeUitnodigingView(): string {
  return layout(
    'Link werkt niet meer',
    `
<main>
  <header><h1>MARKaaS klantportaal</h1></header>
  <section class="actie-kaart">
    <h3>Deze link werkt niet meer</h3>
    <p>De link is verlopen, al gebruikt of onbekend. Een uitnodigingslink is 7 dagen geldig en werkt één keer.</p>
    <p>Heeft u al een wachtwoord gekozen? <a href="/portaal/login">Log dan hier in</a>.
      Anders kan MARKaaS u een nieuwe link sturen.</p>
  </section>
</main>`,
  );
}

export function verlopenFormulierView(): string {
  return layout(
    'Formulier verlopen',
    `
<main>
  <header><h1>MARKaaS klantportaal</h1></header>
  <p class="melding fout">Het formulier is verlopen of ongeldig. Laad de pagina opnieuw en probeer het nog eens.</p>
</main>`,
  );
}

export function nietGevondenView(tekst: string): string {
  return layout(
    'Niet gevonden',
    `
<main>
  <header><h1>MARKaaS klantportaal</h1></header>
  <p class="melding fout">${h(tekst)}</p>
  <p><a class="knop secundair" href="/portaal/">Terug naar de concepten</a></p>
</main>`,
  );
}

// -- concepten -------------------------------------------------------------

function etiket(type: DraftWeergave['type']): string {
  switch (type) {
    case 'invite':
      return 'Connectieverzoek';
    case 'message':
      return 'Bericht';
    case 'inmail':
      return 'InMail';
  }
}

function zichtbaar(w: string): string {
  return w === '—' ? '' : w;
}

function conceptKaart(d: DraftWeergave, csrfToken: string): string {
  const o = d.ontvanger;
  const url = zichtbaar(o.url);
  const stap = d.sequentie
    ? `<div class="sequentie">Stap ${h(d.sequentie.stap)} van ${h(d.sequentie.totaalStappen)} · reeks gestart op ${h(
        formatteerAmsterdam(d.sequentie.gestartOp),
      )}</div>`
    : '';
  const waarom = zichtbaar(d.waarom);
  return `
<article class="actie-kaart" data-type="${h(d.type)}">
  <h3>${h(etiket(d.type))} namens ${h(d.eigenaarNaam)}</h3>
  ${
    d.betaalpoortReden
      ? '<p class="melding fout">Er is geen actief abonnement; goedkeuren kan pas na het starten van een abonnement via <a href="/portaal/abonnement">Abonnement</a>.</p>'
      : ''
  }
  ${stap}
  <div class="ontvanger">
    <div class="naam">${h(zichtbaar(o.naam) || 'Onbekende ontvanger')}</div>
    <div class="functie">${h(zichtbaar(o.functie))}</div>
    <div class="bedrijf">${h(zichtbaar(o.bedrijf))}</div>
    ${url ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">LinkedIn-profiel bekijken</a>` : ''}
  </div>
  ${waarom ? `<div class="waarom"><div class="label">Waarom deze persoon</div><div>${h(waarom)}</div></div>` : ''}
  <div class="tekst">${h(d.tekst)}</div>
  <div class="knoppen">
    <form method="post" action="/portaal/acties/goedkeuren">
      <input type="hidden" name="csrf" value="${h(csrfToken)}">
      <input type="hidden" name="actieId" value="${h(d.actieId)}">
      <button type="submit">Goedkeuren</button>
    </form>
  </div>
  <form method="post" action="/portaal/acties/afwijzen">
    <input type="hidden" name="csrf" value="${h(csrfToken)}">
    <input type="hidden" name="actieId" value="${h(d.actieId)}">
    <div class="knoppen">
      <input type="text" name="reden" placeholder="Waarom afwijzen? (verplicht)" required maxlength="500">
      <button type="submit" class="gevaarlijk">Afwijzen</button>
    </div>
  </form>
</article>`;
}

export interface ConceptenViewOpties extends PortaalPaginaOpties {
  concepten: readonly DraftWeergave[];
}

export function conceptenView(o: ConceptenViewOpties): string {
  const alles =
    o.concepten.length > 1
      ? `
<form method="post" action="/portaal/acties/goedkeuren-alles" class="alles">
  <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
  ${o.concepten.map((d) => `<input type="hidden" name="ids" value="${h(d.actieId)}">`).join('\n  ')}
  <button type="submit">Alle ${o.concepten.length} concepten goedkeuren</button>
  <span class="uitleg">Keurt alleen de concepten op deze pagina goed.</span>
</form>`
      : '';
  const lijst =
    o.concepten.length === 0
      ? '<p class="leeg">Er staan geen concepten klaar. MARKaaS laat het weten als er nieuwe zijn.</p>'
      : o.concepten.map((d) => conceptKaart(d, o.csrfToken)).join('\n');
  return layout(
    'Concepten',
    `
${portaalHeader(o.klantNaam, o.csrfToken, 'concepten', o.betalingMislukt)}
<main>
  ${meldingBlok(o.melding)}
  <h2>Concepten om goed te keuren (${o.concepten.length})</h2>
  <p class="uitleg">Na goedkeuring verstuurt MARKaaS het bericht binnen de afgesproken limieten,
    op werkdagen tussen 08:30 en 17:30. Afgewezen berichten worden niet verstuurd.</p>
  ${alles}
  ${lijst}
</main>`,
  );
}

// -- resultaten ------------------------------------------------------------

const STAND_TEKST: Record<AccountStand, { label: string; klasse: string; uitleg: string }> = {
  gekoppeld: { label: 'Gekoppeld', klasse: 'goed', uitleg: 'Het account werkt.' },
  opbouw: {
    label: 'Gekoppeld · opbouw',
    klasse: 'goed',
    uitleg: 'Het account werkt. We bouwen het aantal berichten per dag rustig op om LinkedIn-beperkingen te voorkomen.',
  },
  afkoeling: {
    label: 'In afkoeling',
    klasse: 'let-op',
    uitleg: 'LinkedIn vroeg om het rustiger aan te doen. We versturen tijdelijk niets.',
  },
  opnieuw_koppelen: {
    label: 'Opnieuw koppelen nodig',
    klasse: 'actie',
    uitleg: 'De verbinding met LinkedIn is verlopen. Log opnieuw in om verder te gaan; tot die tijd wordt niets verstuurd.',
  },
  niet_gekoppeld: {
    label: 'Nog niet gekoppeld',
    klasse: 'actie',
    uitleg: 'Dit account is nog niet aan MARKaaS gekoppeld. Vraag MARKaaS om een nieuwe koppellink voor de accounteigenaar.',
  },
  storing: {
    label: 'Storing',
    klasse: 'let-op',
    uitleg: 'Er is een storing met dit account. MARKaaS kijkt ernaar.',
  },
};

const WEEK_FORMATTER = new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', day: 'numeric', month: 'short' });

function weekLabel(weekStart: string): string {
  return WEEK_FORMATTER.format(new Date(`${weekStart}T00:00:00Z`)).replace(/\.$/, '');
}

function accountKaart(a: AccountResultaat, csrfToken: string): string {
  const s = STAND_TEKST[a.stand];
  const extra =
    a.stand === 'afkoeling' && a.afkoelingTot
      ? ` Tot ${formatteerAmsterdam(a.afkoelingTot)}.`
      : a.stand === 'opbouw'
        ? ` Nu ${a.opbouwPercentage}% van het maximum.`
        : '';
  const knop = kanOpnieuwKoppelen(a.stand)
    ? `<form method="post" action="/portaal/accounts/${h(a.accountId)}/opnieuw-koppelen">
    <input type="hidden" name="csrf" value="${h(csrfToken)}">
    <button type="submit">Opnieuw koppelen</button>
  </form>`
    : '';
  const rijen = [...a.weken]
    .reverse()
    .map(
      (w) =>
        `<tr class="week"><td>${h(weekLabel(w.weekStart))}</td><td>${w.verzoeken}</td><td>${w.acceptaties}</td><td>${w.reacties}</td></tr>`,
    )
    .join('\n');
  return `
<article class="actie-kaart">
  <h3>${h(a.eigenaarNaam)} <span class="stand ${s.klasse}">${h(s.label)}</span></h3>
  <p class="uitleg">${h(s.uitleg + extra)}</p>
  ${knop}
  <table class="weken">
    <thead><tr><th>Week van</th><th>Verzoeken verstuurd</th><th>Geaccepteerd</th><th>Gereageerd</th></tr></thead>
    <tbody>
${rijen}
      <tr class="totaal"><td>Laatste 8 weken</td><td>${a.totaal.verzoeken}</td><td>${a.totaal.acceptaties}</td><td>${a.totaal.reacties}</td></tr>
    </tbody>
  </table>
</article>`;
}

export interface ResultatenViewOpties extends PortaalPaginaOpties {
  accounts: readonly AccountResultaat[];
}

export function resultatenView(o: ResultatenViewOpties): string {
  return layout(
    'Resultaten',
    `
${portaalHeader(o.klantNaam, o.csrfToken, 'resultaten', o.betalingMislukt)}
<main>
  ${meldingBlok(o.melding)}
  <h2>Resultaten per LinkedIn-account</h2>
  <p class="uitleg">Per week (maandag tot en met zondag): verstuurde connectieverzoeken, hoeveel
    mensen het verzoek accepteerden en hoeveel gesprekken een reactie kregen.</p>
  ${
    o.accounts.length === 0
      ? '<p class="leeg">Er zijn nog geen LinkedIn-accounts voor uw organisatie.</p>'
      : o.accounts.map((a) => accountKaart(a, o.csrfToken)).join('\n')
  }
</main>`,
  );
}

// -- abonnement ------------------------------------------------------------

export interface AbonnementViewOpties extends PortaalPaginaOpties {
  weergave: AbonnementWeergave;
  /** Gekoppelde LinkedIn-accounts van de klant. */
  aantalAccounts: number;
  /** false = STRIPE_*-variabelen ontbreken: "Betalen is nog niet ingericht". */
  stripeIngericht: boolean;
  proefperiodeDagen: number;
}

export function abonnementView(o: AbonnementViewOpties): string {
  const w = o.weergave;
  const knop =
    w.knop === null
      ? ''
      : !o.stripeIngericht
        ? '<p class="melding fout">Betalen is nog niet ingericht. Neem contact op met MARKaaS.</p>'
        : w.knop === 'starten'
          ? `<form method="post" action="/portaal/abonnement/starten">
    <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
    <button type="submit">${
      o.proefperiodeDagen > 0 ? `Abonnement starten (${h(o.proefperiodeDagen)} dagen gratis)` : 'Abonnement starten'
    }</button>
  </form>
  <p class="uitleg">U rondt het afrekenen af bij Stripe, onze betaalprovider.${
    o.proefperiodeDagen > 0
      ? ` De eerste ${h(o.proefperiodeDagen)} dagen zijn gratis; zegt u vóór het einde op, dan betaalt u niets.`
      : ''
  }</p>`
          : `<form method="post" action="/portaal/abonnement/beheren">
    <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
    <button type="submit">Abonnement beheren</button>
  </form>
  <p class="uitleg">Betaalgegevens, facturen en opzeggen regelt u in de beveiligde omgeving van Stripe.</p>`;
  return layout(
    'Abonnement',
    `
${portaalHeader(o.klantNaam, o.csrfToken, 'abonnement', o.betalingMislukt)}
<main>
  ${meldingBlok(o.melding)}
  <h2>Abonnement</h2>
  <article class="actie-kaart">
    <h3><span class="stand ${w.soort === 'goed' ? 'goed' : w.soort}">${h(w.titel)}</span></h3>
    <p class="uitleg">${h(w.uitleg)}</p>
    <dl class="abonnement">
      <dt>Volgende betaling</dt><dd>${w.volgendeBetaling ? h(datumTekst(w.volgendeBetaling)) : '—'}</dd>
      <dt>Gekoppelde accounts</dt><dd>${h(o.aantalAccounts)}</dd>
    </dl>
    ${knop}
  </article>
</main>`,
  );
}

export function abonnementTerugView(o: PortaalPaginaOpties & { soort: 'gelukt' | 'geannuleerd' }): string {
  const tekst =
    o.soort === 'gelukt'
      ? `<h3>Dank u wel</h3>
    <p>Uw abonnement is gestart. Het kan een minuut duren voordat de stand hieronder bijgewerkt is.</p>`
      : `<h3>Afrekenen afgebroken</h3>
    <p>Er is geen abonnement gestart en er is niets afgeschreven. U kunt het later opnieuw proberen.</p>`;
  return layout(
    o.soort === 'gelukt' ? 'Abonnement gestart' : 'Afrekenen afgebroken',
    `
${portaalHeader(o.klantNaam, o.csrfToken, 'abonnement', o.betalingMislukt)}
<main>
  <section class="actie-kaart">
    ${tekst}
    <p><a class="knop" href="/portaal/abonnement">Naar uw abonnement</a></p>
  </section>
</main>`,
  );
}
