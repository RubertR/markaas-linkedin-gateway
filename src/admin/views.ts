import type { DraftWeergave, OnzekerWeergave } from './dienst.ts';

/**
 * Server-rendered HTML voor de goedkeuringspagina. Geen framework, geen
 * client-side JavaScript — pure formulieren met CSRF-token. Mobielvriendelijk
 * via `viewport`-meta en responsieve CSS (één kolom op smalle schermen,
 * knoppen minimaal 44 px hoog).
 */

const CSS = `
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
button, .knop {
  background: #0b63b7; color: #fff; border: 0; padding: 0.6rem 0.9rem;
  border-radius: 4px; font-size: 0.95rem; min-height: 44px; cursor: pointer;
}
button.secundair { background: #fff; color: #0b63b7; border: 1px solid #0b63b7; }
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

function layout(titel: string, inhoud: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${h(titel)} — MARKaaS gateway</title>
  <style>${CSS}</style>
</head>
<body>
${inhoud}
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

function draftKaart(d: DraftWeergave, csrfToken: string): string {
  return `
<article class="actie-kaart" data-type="${h(d.type)}">
  <h3>${h(etiket(d.type))} — ${h(d.ontvanger)}</h3>
  <dl>
    <dt>Account</dt><dd>${h(d.clientNaam)} / ${h(d.eigenaarNaam)}</dd>
    <dt>Aangemaakt door</dt><dd>${h(d.aangemaaktDoorSkill)}</dd>
    <dt>Aangemaakt op</dt><dd>${h(d.aangemaaktOp.toISOString())}</dd>
    <dt>Budget</dt><dd class="budget">${h(budgetTekst(d))}</dd>
  </dl>
  <form method="post" action="/admin/acties/goedkeuren">
    <input type="hidden" name="csrf" value="${h(csrfToken)}">
    <input type="hidden" name="actieId" value="${h(d.actieId)}">
    <label for="tekst-${h(d.actieId)}">Volledige tekst (aan te passen vóór goedkeuren)</label>
    <textarea id="tekst-${h(d.actieId)}" name="nieuweTekst">${h(d.tekst)}</textarea>
    <div class="knoppen">
      <label class="checkbox"><input type="checkbox" name="batch" value="${h(d.actieId)}" form="batch-form"> Selecteren voor batch</label>
      <button type="submit">Goedkeuren</button>
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
  <h3>Onzeker — ${h(etiket(o.type))} — ${h(o.ontvanger)}</h3>
  <dl>
    <dt>Account</dt><dd>${h(o.clientNaam)} / ${h(o.eigenaarNaam)}</dd>
    <dt>Reden</dt><dd>${h(o.reden ?? '—')}</dd>
    <dt>Aangemaakt op</dt><dd>${h(o.aangemaaktOp.toISOString())}</dd>
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
  return layout('Goedkeuren', inhoud);
}
