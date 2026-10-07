import type { KlantAbonnement } from '../abonnement/abonnementen.ts';
import { datumTekst, type AbonnementWeergave } from '../abonnement/weergave.ts';

import { formatteerAmsterdam } from './datum.ts';
import type { GebruikerRegel } from '../portaal/gebruikers.ts';

import type { KlantRegel, UitnodigingStand } from './klanten.ts';
import type {
  DraftWeergave,
  OnzekerWeergave,
  OntvangerWeergave,
  SequentieHerkomst,
} from './dienst.ts';

/**
 * Server-rendered HTML voor de goedkeuringspagina. Geen framework, geen
 * client-side JavaScript — pure formulieren met CSRF-token. Mobielvriendelijk
 * via `viewport`-meta en responsieve CSS (één kolom op smalle schermen,
 * knoppen minimaal 44 px hoog).
 */

/** Gedeelde opmaak; ook gebruikt door het klantportaal (src/portaal/views.ts). */
export const BASIS_CSS = `
*,*::before,*::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  background: #f6f7f9;
  color: #1b1f23;
  line-height: 1.4;
  padding: 1rem;
}
header { max-width: 60rem; margin: 0 auto 1rem; display: flex; gap: 1rem; align-items: baseline; }
header h1 { margin: 0; font-size: 1.3rem; }
header nav { margin-left: auto; display: flex; gap: 0.5rem; }
main { max-width: 60rem; margin: 0 auto; }
.melding { padding: 0.6rem 0.8rem; border-radius: 4px; margin: 0 0 1rem; }
.melding.ok { background: #e4f6ea; border: 1px solid #4b9f5e; }
.melding.fout { background: #fdebe8; border: 1px solid #b23c2d; }
.leeg { background: #fff; border: 1px solid #e1e5ea; border-radius: 6px;
        padding: 1rem; text-align: center; color: #555; }
.actie-kaart { background: #fff; border: 1px solid #e1e5ea; border-radius: 6px;
               padding: 0.8rem; margin: 0 0 0.8rem; }
.actie-kaart h3 { margin: 0 0 0.4rem; font-size: 1rem; }
.actie-kaart dl { display: grid; grid-template-columns: 10rem 1fr;
                  gap: 0.2rem 0.6rem; margin: 0 0 0.6rem; }
.actie-kaart dt { font-weight: 600; color: #333; }
.actie-kaart dd { margin: 0; }
.actie-kaart textarea { width: 100%; min-height: 5rem; font-family: inherit;
                        font-size: 0.95rem; padding: 0.4rem;
                        border: 1px solid #c4c9cf; border-radius: 4px; }
.actie-kaart .knoppen { display: flex; flex-wrap: wrap; gap: 0.4rem;
                        margin-top: 0.4rem; }
.actie-kaart .knoppen input[type="text"] { flex: 1 1 10rem; padding: 0.4rem;
                                           border: 1px solid #c4c9cf; border-radius: 4px; }
.ontvanger { margin: 0 0 0.6rem; }
.ontvanger .naam { font-weight: 600; font-size: 1.05rem; }
.ontvanger .functie { color: #333; }
.ontvanger .bedrijf { color: #333; }
.ontvanger a { color: #0b63b7; text-decoration: underline; }
.ontvanger small { color: #666; display: block; margin-top: 0.1rem;
                   font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.waarom { background: #f0f4f8; border-left: 3px solid #0b63b7;
          padding: 0.4rem 0.6rem; margin: 0 0 0.6rem; border-radius: 3px; }
.waarom .label { font-weight: 600; color: #0b63b7; font-size: 0.85rem; }
.sequentie { background: #f7f0e4; border-left: 3px solid #a86b00;
             padding: 0.3rem 0.6rem; margin: 0 0 0.6rem; border-radius: 3px;
             font-size: 0.9rem; color: #5a3b00; }
.teken-teller { font-size: 0.85rem; color: #555; margin: 0.2rem 0 0.4rem; }
.teken-teller.over { color: #b23c2d; font-weight: 600; }
button[disabled] { opacity: 0.5; cursor: not-allowed; }
button, .knop {
  background: #0b63b7; color: #fff; border: 0; padding: 0.6rem 0.9rem;
  border-radius: 4px; font-size: 0.95rem; min-height: 44px; cursor: pointer;
}
button.secundair, a.knop.secundair { background: #fff; color: #0b63b7; border: 1px solid #0b63b7; }
a.knop { display: inline-flex; align-items: center; text-decoration: none; }
table.klanten { width: 100%; border-collapse: collapse; background: #fff;
                border: 1px solid #e1e5ea; border-radius: 6px; margin: 0 0 1rem; }
table.klanten th, table.klanten td { text-align: left; padding: 0.5rem 0.6rem;
                                     border-bottom: 1px solid #eef0f3; vertical-align: top; }
table.klanten th { font-size: 0.85rem; color: #555; }
.formulier label { display: block; font-weight: 600; margin: 0.6rem 0 0.2rem; }
.formulier select { padding: 0.6rem; font-size: 1rem; border: 1px solid #c4c9cf;
                    border-radius: 4px; width: 100%; }
.formulier input[type="email"] { padding: 0.6rem; border: 1px solid #c4c9cf; border-radius: 4px;
                                 font-size: 1rem; width: 100%; }
.formulier label.checkbox { font-weight: 400; display: inline-flex; margin-top: 0.8rem; }
.uitleg { color: #555; font-size: 0.9rem; margin: 0.2rem 0 0; }
textarea.kopie { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                 font-size: 0.9rem; padding: 0.5rem; border: 1px solid #c4c9cf; border-radius: 4px; }
button.gevaarlijk { background: #b23c2d; }
.batch { display: flex; align-items: center; gap: 0.6rem; margin: 1rem 0; }
.batch button { background: #197a3d; }
.batch label { color: #333; }
form { margin: 0; }
label.checkbox { display: inline-flex; align-items: center; gap: 0.3rem;
                 user-select: none; }
input[type="password"], input[type="text"] {
  padding: 0.6rem; border: 1px solid #c4c9cf; border-radius: 4px;
  font-size: 1rem; width: 100%;
}
.budget { font-size: 0.85rem; color: #444; }
@media (max-width: 40rem) {
  .actie-kaart dl { grid-template-columns: 1fr; }
  header { flex-wrap: wrap; }
}
`;

export function h(waarde: unknown): string {
  if (waarde == null) return '';
  return String(waarde)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Kleine vanilla-JS teller: werkt het "nog N tekens"-label live bij en
// schakelt Goedkeuren uit zodra de tekst over de limiet gaat. Server-side
// controleert `goedkeur` dit óók — dit is enkel ergonomie.
const TELLER_JS = `
document.querySelectorAll('textarea[data-maxtekens]').forEach(function (ta) {
  var max = Number(ta.dataset.maxtekens);
  var teller = ta.parentElement.querySelector('.teken-teller');
  var knop = ta.form ? ta.form.querySelector('button[type="submit"]') : null;
  function werkBij() {
    var lengte = ta.value.length;
    var over = lengte > max;
    if (teller) {
      teller.textContent = over
        ? (lengte + '/' + max + ' tekens — boven de limiet, korter maken')
        : (lengte + '/' + max + ' tekens (nog ' + (max - lengte) + ')');
      teller.classList.toggle('over', over);
    }
    if (knop) knop.disabled = over;
  }
  ta.addEventListener('input', werkBij);
  werkBij();
});
`.trim();

function layout(titel: string, inhoud: string, metScript = false): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${h(titel)} — MARKaaS gateway</title>
  <style>${BASIS_CSS}</style>
</head>
<body>
${inhoud}
${metScript ? `<script>${TELLER_JS}</script>` : ''}
</body>
</html>`;
}

export interface LoginViewOpties {
  csrfToken: string;
  foutmelding?: string;
  blokkadeSeconden?: number;
}

export function loginView(opts: LoginViewOpties): string {
  const inhoud = `
<main>
  <header><h1>Goedkeuringspagina</h1></header>
  ${opts.foutmelding ? `<p class="melding fout">${h(opts.foutmelding)}</p>` : ''}
  ${
    opts.blokkadeSeconden
      ? `<p class="melding fout">Te veel foute pogingen. Probeer opnieuw over ${h(
          Math.ceil(opts.blokkadeSeconden / 60),
        )} minuten.</p>`
      : ''
  }
  <form method="post" action="/admin/login" autocomplete="off">
    <input type="hidden" name="csrf" value="${h(opts.csrfToken)}">
    <label for="wachtwoord">Wachtwoord</label>
    <input id="wachtwoord" name="wachtwoord" type="password" required
           autocomplete="current-password" autofocus>
    <p><button type="submit">Inloggen</button></p>
  </form>
</main>
`;
  return layout('Inloggen', inhoud);
}

function budgetTekst(d: DraftWeergave): string {
  const b = d.budget;
  const stukjes: string[] = [];
  if (b.dag) stukjes.push(`dag ${b.dag.gebruikt}/${b.dag.norm} (nog ${b.dag.resterend})`);
  if (b.week) stukjes.push(`week ${b.week.gebruikt}/${b.week.norm} (nog ${b.week.resterend})`);
  if (b.maand) stukjes.push(`maand ${b.maand.gebruikt}/${b.maand.norm} (nog ${b.maand.resterend})`);
  return stukjes.join(' · ');
}

function sequentieBanner(s: SequentieHerkomst): string {
  return `
<div class="sequentie">
  Stap ${h(s.stap)} van ${h(s.totaalStappen)} ·
  sequentie gestart op ${h(formatteerAmsterdam(s.gestartOp))}
</div>`;
}

function ontvangerBlok(o: OntvangerWeergave): string {
  return `
<div class="ontvanger">
  <div class="naam">${h(o.naam)}</div>
  <div class="functie">${h(o.functie)}</div>
  <div class="bedrijf">${h(o.bedrijf)}</div>
  ${
    o.url && o.url !== '—'
      ? `<a href="${h(o.url)}" target="_blank" rel="noopener noreferrer">LinkedIn-profiel openen</a>`
      : ''
  }
  <small>id: ${h(o.technischeId)}</small>
</div>`;
}

function draftKaart(d: DraftWeergave, csrfToken: string): string {
  const vrij = Math.max(0, d.tekenMax - d.tekst.length);
  const teLang = d.tekst.length > d.tekenMax;
  return `
<article class="actie-kaart" data-type="${h(d.type)}">
  <h3>${h(etiket(d.type))}</h3>
  ${d.betaalpoortReden ? `<p class="melding fout">${h(d.betaalpoortReden)} Na goedkeuring wordt dit concept geweigerd.</p>` : ''}
  ${d.sequentie ? sequentieBanner(d.sequentie) : ''}
  ${ontvangerBlok(d.ontvanger)}
  <div class="waarom">
    <div class="label">Waarom</div>
    <div>${h(d.waarom)}</div>
  </div>
  <dl>
    <dt>Account</dt><dd>${h(d.clientNaam)} / ${h(d.eigenaarNaam)}</dd>
    <dt>Aangemaakt door</dt><dd>${h(d.aangemaaktDoorSkill)}</dd>
    <dt>Aangemaakt op</dt><dd>${h(formatteerAmsterdam(d.aangemaaktOp))}</dd>
    <dt>Budget</dt><dd class="budget">${h(budgetTekst(d))}</dd>
  </dl>
  <form method="post" action="/admin/acties/goedkeuren">
    <input type="hidden" name="csrf" value="${h(csrfToken)}">
    <input type="hidden" name="actieId" value="${h(d.actieId)}">
    <label for="tekst-${h(d.actieId)}">Volledige tekst (aan te passen vóór goedkeuren)</label>
    <textarea id="tekst-${h(d.actieId)}" name="nieuweTekst"
              data-maxtekens="${h(d.tekenMax)}">${h(d.tekst)}</textarea>
    <div class="teken-teller${teLang ? ' over' : ''}" data-voor="${h(d.actieId)}">
      ${h(d.tekst.length)}/${h(d.tekenMax)} tekens${teLang ? ' — boven de limiet, korter maken' : ` (nog ${h(vrij)})`}
    </div>
    <div class="knoppen">
      <label class="checkbox"><input type="checkbox" name="batch" value="${h(d.actieId)}" form="batch-form"> Selecteren voor batch</label>
      <button type="submit" ${teLang ? 'disabled' : ''}>Goedkeuren</button>
    </div>
  </form>
  <form method="post" action="/admin/acties/afwijzen">
    <input type="hidden" name="csrf" value="${h(csrfToken)}">
    <input type="hidden" name="actieId" value="${h(d.actieId)}">
    <div class="knoppen">
      <input type="text" name="reden" placeholder="Reden van afwijzen" required>
      <button type="submit" class="gevaarlijk">Afwijzen</button>
    </div>
  </form>
</article>`;
}

function onzekerKaart(o: OnzekerWeergave, csrfToken: string): string {
  return `
<article class="actie-kaart">
  <h3>Onzeker — ${h(etiket(o.type))}</h3>
  ${ontvangerBlok(o.ontvanger)}
  <div class="waarom">
    <div class="label">Waarom</div>
    <div>${h(o.waarom)}</div>
  </div>
  <dl>
    <dt>Account</dt><dd>${h(o.clientNaam)} / ${h(o.eigenaarNaam)}</dd>
    <dt>Reden</dt><dd>${h(o.reden ?? '—')}</dd>
    <dt>Aangemaakt op</dt><dd>${h(formatteerAmsterdam(o.aangemaaktOp))}</dd>
    <dt>Tekst</dt><dd><pre style="white-space:pre-wrap;margin:0">${h(o.tekst)}</pre></dd>
  </dl>
  <div class="knoppen">
    <form method="post" action="/admin/acties/onzeker-done">
      <input type="hidden" name="csrf" value="${h(csrfToken)}">
      <input type="hidden" name="actieId" value="${h(o.actieId)}">
      <button type="submit" class="secundair">Was verstuurd → done</button>
    </form>
    <form method="post" action="/admin/acties/onzeker-opnieuw">
      <input type="hidden" name="csrf" value="${h(csrfToken)}">
      <input type="hidden" name="actieId" value="${h(o.actieId)}">
      <button type="submit">Opnieuw goedkeuren</button>
    </form>
  </div>
</article>`;
}

function etiket(type: 'invite' | 'message' | 'inmail'): string {
  switch (type) {
    case 'invite':
      return 'Connectieverzoek';
    case 'message':
      return 'Bericht';
    case 'inmail':
      return 'InMail';
  }
}

export interface OverzichtViewOpties {
  csrfToken: string;
  drafts: readonly DraftWeergave[];
  onzeker: readonly OnzekerWeergave[];
  melding?: { soort: 'ok' | 'fout'; tekst: string };
}

export function overzichtView(opts: OverzichtViewOpties): string {
  const batchForm = `
<form id="batch-form" method="post" action="/admin/acties/goedkeuren-batch" class="batch">
  <input type="hidden" name="csrf" value="${h(opts.csrfToken)}">
  <button type="submit">Geselecteerde goedkeuren</button>
  <span>Vink hierboven acties aan en klik hier om er meerdere in één keer goed te keuren.</span>
</form>`;

  const draftsSectie =
    opts.drafts.length === 0
      ? `<p class="leeg">Geen concepten in de wachtrij.</p>`
      : opts.drafts.map((d) => draftKaart(d, opts.csrfToken)).join('\n');

  const onzekerSectie =
    opts.onzeker.length === 0
      ? `<p class="leeg">Geen onzeker-acties.</p>`
      : opts.onzeker.map((o) => onzekerKaart(o, opts.csrfToken)).join('\n');

  const inhoud = `
<header>
  <h1>Goedkeuringspagina</h1>
  <nav>
    <a class="knop secundair" href="/admin/klanten">Klanten</a>
    <form method="post" action="/admin/logout">
      <input type="hidden" name="csrf" value="${h(opts.csrfToken)}">
      <button type="submit" class="secundair">Uitloggen</button>
    </form>
  </nav>
</header>
<main>
  ${
    opts.melding
      ? `<p class="melding ${opts.melding.soort}">${h(opts.melding.tekst)}</p>`
      : ''
  }
  <section>
    <h2>Concepten (${opts.drafts.length})</h2>
    ${batchForm}
    ${draftsSectie}
  </section>
  <section>
    <h2>Onzeker (${opts.onzeker.length})</h2>
    ${onzekerSectie}
  </section>
</main>`;
  return layout('Goedkeuren', inhoud, true);
}

// -- klanten en koppellinks (SPEC §14.2) -----------------------------------

function adminHeader(titel: string, csrfToken: string): string {
  return `
<header>
  <h1>${h(titel)}</h1>
  <nav>
    <a class="knop secundair" href="/admin/">Concepten</a>
    <a class="knop secundair" href="/admin/klanten">Klanten</a>
    <form method="post" action="/admin/logout">
      <input type="hidden" name="csrf" value="${h(csrfToken)}">
      <button type="submit" class="secundair">Uitloggen</button>
    </form>
  </nav>
</header>`;
}

const STATUS_TEKST: Record<string, string> = {
  OK: 'werkt',
  RECONNECTED: 'werkt (opnieuw gekoppeld)',
  CONNECTING: 'wacht op koppelen',
  CREDENTIALS: 'opnieuw inloggen nodig',
  ERROR: 'fout',
  STOPPED: 'gestopt',
  PERMISSIONS: 'rechten ontbreken',
  UNKNOWN: 'onbekend',
};

function uitnodigingTekst(stand: UitnodigingStand, verlooptOp: Date | null): string {
  switch (stand) {
    case 'geen':
      return 'geen koppellink';
    case 'open':
      return `link open tot ${verlooptOp ? formatteerAmsterdam(verlooptOp) : '—'}`;
    case 'verlopen':
      return 'link verlopen';
    case 'gebruikt':
      return 'link gebruikt';
  }
}

export interface KlantenViewOpties {
  csrfToken: string;
  klanten: readonly KlantRegel[];
  melding?: { soort: 'ok' | 'fout'; tekst: string };
}

export function klantenView(opts: KlantenViewOpties): string {
  const rijen = opts.klanten
    .map((k) => {
      const accounts =
        k.accounts.length === 0
          ? [`<tr><td><a href="/admin/klanten/${h(k.slug)}">${h(k.naam)}</a><br><small>${h(k.slug)}</small></td><td colspan="4">Geen accounts.</td></tr>`]
          : k.accounts.map(
              (a, i) => `
<tr>
  <td>${i === 0 ? `<a href="/admin/klanten/${h(k.slug)}">${h(k.naam)}</a><br><small>${h(k.slug)} · abonnement ${k.abonnementVereist ? 'vereist' : 'niet vereist'}</small>` : ''}</td>
  <td>${h(a.eigenaarNaam)}${a.eigenaarEmail ? `<br><small>${h(a.eigenaarEmail)}</small>` : ''}</td>
  <td>${h(STATUS_TEKST[a.status] ?? a.status)}<br><small>${h(a.abonnement)}</small></td>
  <td>${a.gekoppeld ? 'ja' : 'nee'}${a.gekoppeld ? '' : `<br><small>${h(uitnodigingTekst(a.uitnodiging, a.uitnodigingVerlooptOp))}</small>`}</td>
  <td>${
    a.gekoppeld
      ? ''
      : `<form method="post" action="/admin/klanten/${h(a.id)}/koppellink">
      <input type="hidden" name="csrf" value="${h(opts.csrfToken)}">
      <button type="submit" class="secundair">Nieuwe koppellink</button>
    </form>`
  }</td>
</tr>`,
            );
      return accounts.join('');
    })
    .join('');
  const inhoud = `
${adminHeader('Klanten', opts.csrfToken)}
<main>
  ${opts.melding ? `<p class="melding ${opts.melding.soort}">${h(opts.melding.tekst)}</p>` : ''}
  <p><a class="knop" href="/admin/klanten/nieuw">Nieuwe klant</a></p>
  ${
    opts.klanten.length === 0
      ? '<p class="leeg">Nog geen klanten.</p>'
      : `<table class="klanten">
    <thead><tr><th>Klant</th><th>Accounteigenaar</th><th>Status</th><th>Gekoppeld</th><th></th></tr></thead>
    <tbody>${rijen}</tbody>
  </table>`
  }
</main>`;
  return layout('Klanten', inhoud);
}

export interface NieuweKlantWaarden {
  klantNaam: string;
  slug: string;
  eigenaarNaam: string;
  eigenaarEmail: string;
  abonnement: string;
  abonnementVereist: boolean;
}

export interface NieuweKlantViewOpties {
  csrfToken: string;
  abonnementen: readonly string[];
  waarden?: NieuweKlantWaarden;
  foutmelding?: string;
}

// Vult de slug voor zolang Rubert hem niet zelf heeft aangepast. Server-side
// geldt hetzelfde voorstel als het veld leeg blijft.
const SLUG_JS = `
(function () {
  var naam = document.getElementById('klantNaam');
  var slug = document.getElementById('slug');
  if (!naam || !slug) return;
  var handmatig = slug.value !== '';
  slug.addEventListener('input', function () { handmatig = slug.value !== ''; });
  naam.addEventListener('input', function () {
    if (handmatig) return;
    slug.value = naam.value.trim().toLowerCase()
      .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  });
})();
`.trim();

export function nieuweKlantView(opts: NieuweKlantViewOpties): string {
  const w: NieuweKlantWaarden = opts.waarden ?? {
    klantNaam: '',
    slug: '',
    eigenaarNaam: '',
    eigenaarEmail: '',
    abonnement: 'premium_business',
    abonnementVereist: true,
  };
  const opties = opts.abonnementen
    .map((a) => `<option value="${h(a)}"${a === w.abonnement ? ' selected' : ''}>${h(a)}</option>`)
    .join('');
  const inhoud = `
${adminHeader('Nieuwe klant', opts.csrfToken)}
<main>
  ${opts.foutmelding ? `<p class="melding fout">${h(opts.foutmelding)}</p>` : ''}
  <form method="post" action="/admin/klanten/nieuw" class="formulier actie-kaart" autocomplete="off">
    <input type="hidden" name="csrf" value="${h(opts.csrfToken)}">
    <label for="klantNaam">Klantnaam</label>
    <input id="klantNaam" name="klantNaam" type="text" required maxlength="200" value="${h(w.klantNaam)}">
    <label for="slug">Slug</label>
    <input id="slug" name="slug" type="text" maxlength="60" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="${h(w.slug)}">
    <p class="uitleg">Kleine letters, cijfers en koppeltekens. Leeg = voorstel uit de klantnaam.</p>
    <label for="eigenaarNaam">Naam accounteigenaar</label>
    <input id="eigenaarNaam" name="eigenaarNaam" type="text" required maxlength="200" value="${h(w.eigenaarNaam)}">
    <label for="eigenaarEmail">E-mail accounteigenaar</label>
    <input id="eigenaarEmail" name="eigenaarEmail" type="email" required maxlength="254" value="${h(w.eigenaarEmail)}">
    <label for="abonnement">LinkedIn-abonnement</label>
    <select id="abonnement" name="abonnement">${opties}</select>
    <label class="checkbox"><input type="checkbox" name="abonnementVereist" value="ja"${w.abonnementVereist ? ' checked' : ''}> Abonnement vereist (betaalpoort, SPEC §14.4)</label>
    <p><button type="submit">Klant aanmaken en koppellink maken</button></p>
  </form>
</main>
<script>${SLUG_JS}</script>`;
  return layout('Nieuwe klant', inhoud);
}

export interface KoppellinkViewOpties {
  csrfToken: string;
  link: string;
  klantNaam: string;
  eigenaarNaam: string;
  eigenaarEmail: string | null;
  verlooptOp: Date;
}

export function voorbeeldMail(o: Omit<KoppellinkViewOpties, 'csrfToken'>): string {
  const voornaam = o.eigenaarNaam.trim().split(/\s+/)[0] ?? o.eigenaarNaam;
  return `Onderwerp: Uw LinkedIn-account koppelen aan MARKaaS

Beste ${voornaam},

Zoals besproken koppelen we uw LinkedIn-account aan de MARKaaS-gateway. Via de link hieronder leest u wat dat inhoudt, geeft u toestemming en logt u in bij LinkedIn via de beveiligde pagina van onze partner Unipile. MARKaaS ziet uw wachtwoord niet, en elk bericht wordt eerst door ons goedgekeurd voordat het verstuurd wordt.

${o.link}

De link is persoonlijk, werkt één keer en is geldig tot ${formatteerAmsterdam(o.verlooptOp)}. Het koppelen duurt ongeveer vijf minuten; houd uw telefoon bij de hand voor een eventuele verificatiecode van LinkedIn.

Met vriendelijke groet,

Rubert Rietkerk
MARKaaS`;
}

export function koppellinkView(o: KoppellinkViewOpties): string {
  const inhoud = `
${adminHeader('Koppellink', o.csrfToken)}
<main>
  <p class="melding ok">Koppellink gemaakt voor ${h(o.eigenaarNaam)}${
    o.eigenaarEmail ? ` (${h(o.eigenaarEmail)})` : ''
  }, ${h(o.klantNaam)}. Geldig tot ${h(formatteerAmsterdam(o.verlooptOp))}, eenmalig te gebruiken.</p>
  <p class="melding fout">Kopieer de link nu: hij is hierna niet meer op te vragen (alleen een hash is
    opgeslagen). Kwijt? Maak via Klanten een nieuwe koppellink.</p>
  <section class="actie-kaart">
    <h3>Koppellink</h3>
    <textarea id="link" class="kopie" rows="2" readonly>${h(o.link)}</textarea>
    <p><button type="button" class="secundair" onclick="navigator.clipboard.writeText(document.getElementById('link').value)">Kopieer link</button></p>
  </section>
  <section class="actie-kaart">
    <h3>Voorbeeldmail</h3>
    <textarea id="mail" class="kopie" rows="18" readonly>${h(voorbeeldMail(o))}</textarea>
    <p><button type="button" class="secundair" onclick="navigator.clipboard.writeText(document.getElementById('mail').value)">Kopieer mail</button></p>
  </section>
  <p><a class="knop secundair" href="/admin/klanten">Terug naar klanten</a></p>
</main>`;
  return layout('Koppellink', inhoud);
}


// -- klantdetail en portaalgebruikers (SPEC §14.3) -------------------------

function gebruikerLinkStand(g: GebruikerRegel): string {
  if (!g.actief) return 'gedeactiveerd';
  const link = (() => {
    switch (g.uitnodiging) {
      case 'geen':
        return 'geen link';
      case 'open':
        return `link open tot ${g.uitnodigingVerlooptOp ? formatteerAmsterdam(g.uitnodigingVerlooptOp) : '—'}`;
      case 'verlopen':
        return 'link verlopen';
      case 'gebruikt':
        return 'link gebruikt';
    }
  })();
  return g.heeftWachtwoord ? `actief · ${link}` : `wacht op wachtwoord · ${link}`;
}

export interface GebruikerWaarden {
  naam: string;
  email: string;
}

export interface KlantAbonnementWeergave {
  weergave: AbonnementWeergave;
  abonnement: KlantAbonnement | null;
  stripeIngericht: boolean;
}

export interface KlantDetailViewOpties {
  csrfToken: string;
  klant: KlantRegel;
  gebruikers: readonly GebruikerRegel[];
  /** Abonnement (SPEC §14.4). Ontbreekt in oudere tests: dan geen sectie. */
  abonnement?: KlantAbonnementWeergave;
  melding?: { soort: 'ok' | 'fout'; tekst: string };
  waarden?: GebruikerWaarden;
}

export function klantDetailView(o: KlantDetailViewOpties): string {
  const k = o.klant;
  const basis = `/admin/klanten/${encodeURIComponent(k.slug)}`;
  const accounts =
    k.accounts.length === 0
      ? '<p class="leeg">Geen accounts.</p>'
      : `<table class="klanten">
    <thead><tr><th>Accounteigenaar</th><th>Status</th><th>Gekoppeld</th></tr></thead>
    <tbody>${k.accounts
      .map(
        (a) => `
      <tr><td>${h(a.eigenaarNaam)}${a.eigenaarEmail ? `<br><small>${h(a.eigenaarEmail)}</small>` : ''}</td>
      <td>${h(STATUS_TEKST[a.status] ?? a.status)}<br><small>${h(a.abonnement)}</small></td>
      <td>${a.gekoppeld ? 'ja' : `nee<br><small>${h(uitnodigingTekst(a.uitnodiging, a.uitnodigingVerlooptOp))}</small>`}</td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
  const gebruikers =
    o.gebruikers.length === 0
      ? '<p class="leeg">Nog geen portaalgebruikers.</p>'
      : `<table class="klanten">
    <thead><tr><th>Gebruiker</th><th>Stand</th><th>Laatst ingelogd</th><th></th></tr></thead>
    <tbody>${o.gebruikers
      .map(
        (g) => `
      <tr><td>${h(g.naam)}<br><small>${h(g.email)}</small></td>
      <td>${h(gebruikerLinkStand(g))}</td>
      <td>${g.laatstIngelogdOp ? h(formatteerAmsterdam(g.laatstIngelogdOp)) : '—'}</td>
      <td><div class="knoppen">
        <form method="post" action="${basis}/gebruikers/${h(g.id)}/nieuwe-link">
          <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
          <button type="submit" class="secundair">${g.actief ? 'Nieuwe link' : 'Activeren met nieuwe link'}</button>
        </form>
        ${
          g.actief
            ? `<form method="post" action="${basis}/gebruikers/${h(g.id)}/deactiveren">
          <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
          <button type="submit" class="gevaarlijk">Deactiveren</button>
        </form>`
            : ''
        }
      </div></td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
  const w = o.waarden ?? { naam: '', email: '' };
  const inhoud = `
${adminHeader(k.naam, o.csrfToken)}
<main>
  ${o.melding ? `<p class="melding ${o.melding.soort}">${h(o.melding.tekst)}</p>` : ''}
  <p class="uitleg">${h(k.slug)} · abonnement ${k.abonnementVereist ? 'vereist' : 'niet vereist'}</p>
  ${o.abonnement ? abonnementSectie(basis, o.csrfToken, k.abonnementVereist, o.abonnement) : ''}
  <section>
    <h2>LinkedIn-accounts</h2>
    ${accounts}
  </section>
  <section>
    <h2>Portaalgebruikers</h2>
    ${gebruikers}
    <p class="uitleg">"Nieuwe link" is ook voor wachtwoord vergeten. Deactiveren logt de gebruiker direct overal uit.</p>
  </section>
  <section>
    <h2>Gebruiker uitnodigen</h2>
    <form method="post" action="${basis}/gebruikers" class="formulier actie-kaart" autocomplete="off">
      <input type="hidden" name="csrf" value="${h(o.csrfToken)}">
      <label for="naam">Naam</label>
      <input id="naam" name="naam" type="text" required maxlength="200" value="${h(w.naam)}">
      <label for="email">E-mail</label>
      <input id="email" name="email" type="email" required maxlength="254" value="${h(w.email)}">
      <p><button type="submit">Uitnodigingslink maken</button></p>
    </form>
  </section>
  <p><a class="knop secundair" href="/admin/klanten">Terug naar klanten</a></p>
</main>`;
  return layout(k.naam, inhoud);
}

export interface GebruikerLinkViewOpties {
  csrfToken: string;
  slug: string;
  link: string;
  klantNaam: string;
  naam: string;
  email: string;
  verlooptOp: Date;
}

export function voorbeeldMailPortaal(o: Omit<GebruikerLinkViewOpties, 'csrfToken' | 'slug'>): string {
  const voornaam = o.naam.trim().split(/\s+/)[0] ?? o.naam;
  return `Onderwerp: Uw toegang tot het MARKaaS klantportaal

Beste ${voornaam},

U heeft toegang tot het klantportaal van MARKaaS voor ${o.klantNaam}. Daar ziet u de LinkedIn-berichten die wij voor uw accounts hebben voorbereid. U keurt ze goed of wijst ze af; er wordt niets verstuurd zonder goedkeuring. Ook ziet u per week hoeveel verzoeken zijn verstuurd en geaccepteerd en hoeveel reacties er kwamen.

Via de link hieronder kiest u uw wachtwoord (minimaal 12 tekens). Daarna logt u in met ${o.email}.

${o.link}

De link is persoonlijk, werkt één keer en is geldig tot ${formatteerAmsterdam(o.verlooptOp)}.

Met vriendelijke groet,

Rubert Rietkerk
MARKaaS`;
}

export function gebruikerLinkView(o: GebruikerLinkViewOpties): string {
  const inhoud = `
${adminHeader('Uitnodigingslink', o.csrfToken)}
<main>
  <p class="melding ok">Uitnodigingslink gemaakt voor ${h(o.naam)} (${h(o.email)}), ${h(o.klantNaam)}.
    Geldig tot ${h(formatteerAmsterdam(o.verlooptOp))}, eenmalig te gebruiken.</p>
  <p class="melding fout">Kopieer de link nu: hij is hierna niet meer op te vragen (alleen een hash is
    opgeslagen). Kwijt? Maak bij de klant een nieuwe link.</p>
  <section class="actie-kaart">
    <h3>Uitnodigingslink</h3>
    <textarea id="link" class="kopie" rows="2" readonly>${h(o.link)}</textarea>
    <p><button type="button" class="secundair" onclick="navigator.clipboard.writeText(document.getElementById('link').value)">Kopieer link</button></p>
  </section>
  <section class="actie-kaart">
    <h3>Voorbeeldmail</h3>
    <textarea id="mail" class="kopie" rows="18" readonly>${h(voorbeeldMailPortaal(o))}</textarea>
    <p><button type="button" class="secundair" onclick="navigator.clipboard.writeText(document.getElementById('mail').value)">Kopieer mail</button></p>
  </section>
  <p><a class="knop secundair" href="/admin/klanten/${h(o.slug)}">Terug naar ${h(o.klantNaam)}</a></p>
</main>`;
  return layout('Uitnodigingslink', inhoud);
}

function abonnementSectie(basis: string, csrfToken: string, vereist: boolean, a: KlantAbonnementWeergave): string {
  const ab = a.abonnement;
  const regels: string[] = [
    `<dt>Stand</dt><dd>${h(a.weergave.titel)}${ab?.status ? ` <small>(Stripe: ${h(ab.status)})</small>` : ''}</dd>`,
    `<dt>Verzenden</dt><dd>${a.weergave.verzendenToegestaan ? 'toegestaan' : 'geblokkeerd: abonnement niet actief'}</dd>`,
  ];
  if (ab?.proefTot) regels.push(`<dt>Proef tot</dt><dd>${h(datumTekst(ab.proefTot))}</dd>`);
  if (ab?.periodeTot) regels.push(`<dt>Periode tot</dt><dd>${h(datumTekst(ab.periodeTot))}</dd>`);
  if (ab?.opgezegdPerEinde) regels.push('<dt>Opgezegd</dt><dd>per einde van de periode</dd>');
  if (ab?.stripeCustomerId) regels.push(`<dt>Stripe-klant</dt><dd><small>${h(ab.stripeCustomerId)}</small></dd>`);
  return `
  <section>
    <h2>Abonnement</h2>
    ${a.stripeIngericht ? '' : '<p class="melding fout">Betalen is nog niet ingericht (STRIPE_*-variabelen ontbreken).</p>'}
    <div class="actie-kaart">
      <dl>${regels.join('')}</dl>
      <form method="post" action="${basis}/abonnement-vereist" class="knoppen">
        <input type="hidden" name="csrf" value="${h(csrfToken)}">
        <label><input type="checkbox" name="vereist" value="ja"${vereist ? ' checked' : ''}>
          Abonnement vereist voor verzenden</label>
        <button type="submit" class="secundair">Opslaan</button>
      </form>
      <p class="uitleg">Uit voor eigen organisaties (MARKaaS, IPknowledge, TAG): dan wordt er nooit tegengehouden.</p>
    </div>
  </section>`;
}
