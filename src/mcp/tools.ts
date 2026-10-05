import { inAfkoeling } from '../budget/afkoeling.ts';
import type { Klok } from '../budget/klok.ts';
import { telGebruikOpDag, telGebruikOverDagen } from '../budget/gebruik.ts';
import type {
  AbonnementLimieten,
  ActieType,
  Limieten,
} from '../budget/limits.ts';
import { geschaaldeNorm, weekBudgetMetBonus } from '../budget/opbouw.ts';
import { dagenInMaand, formatteerLokaal, lokaleDag, lokaleDagen } from '../budget/tijdvenster.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, type ActieStatus } from '../queue/acties.ts';
import type { PauzeKiezer } from '../queue/pauze.ts';
import {
  lijstActiesVoorSequentie,
  startSequentie,
  type Lead,
  type SequentieTeksten,
} from '../sequences/motor.ts';
import type { UnipileClient } from '../unipile/client.ts';

import { TOOL_NAMEN, type ToolNaam } from './schema.ts';
import {
  McpSynchroonFout,
  voerSynchroonUit,
  type SynchroonContext,
} from './synchroon.ts';

/**
 * Harde regels (CLAUDE.md + SPEC §7, §12):
 * - Geen tool keurt een actie goed, wijst af of verstuurt rechtstreeks naar
 *   Unipile. `queue_action` plaatst uitsluitend `draft`.
 * - `search_people` en `get_profile` lopen via `voerSynchroonUit` dat de
 *   budgetmotor en de bestaande worker gebruikt — nooit `unipile.*` direct.
 * - Alle NL-foutmeldingen bevatten oorzaak + vervolgstap.
 */

export interface McpToolsDeps {
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  klok: Klok;
  pauzeKiezer: PauzeKiezer;
}

export class McpToolInvoerFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'McpToolInvoerFout';
  }
}

export function isBekendeTool(naam: string): naam is ToolNaam {
  return (TOOL_NAMEN as readonly string[]).includes(naam);
}

export async function voerTool(
  deps: McpToolsDeps,
  naam: string,
  argumenten: Record<string, unknown>,
): Promise<unknown> {
  if (!isBekendeTool(naam)) {
    throw new McpToolInvoerFout(
      `Onbekende tool "${naam}". Beschikbaar: ${TOOL_NAMEN.join(', ')}.`,
    );
  }
  switch (naam) {
    case 'list_accounts':
      return await listAccounts(deps, argumenten);
    case 'account_health':
      return await accountHealth(deps, argumenten);
    case 'get_budget':
      return await getBudget(deps, argumenten);
    case 'search_people':
      return await searchPeople(deps, argumenten);
    case 'get_profile':
      return await getProfile(deps, argumenten);
    case 'queue_action':
      return await queueAction(deps, argumenten);
    case 'start_sequence':
      return await startSequenceTool(deps, argumenten);
    case 'get_results':
      return await getResults(deps, argumenten);
  }
}

// -- list_accounts -----------------------------------------------------------

interface AccountRij {
  id: string;
  client_slug: string;
  client_naam: string;
  eigenaar_naam: string;
  abonnement: string;
  status: string;
  status_sinds: string | Date;
  opbouw_factor: string | number;
  afkoeling_tot: string | Date | null;
  unipile_account_id: string | null;
  tijdzone: string;
  openstaande_verzoeken: number;
}

async function listAccounts(deps: McpToolsDeps, args: Record<string, unknown>) {
  const slug = args['clientSlug'];
  if (slug !== undefined && typeof slug !== 'string') {
    throw new McpToolInvoerFout('Veld "clientSlug" moet een tekst zijn.');
  }
  const rijen = await deps.db.query<AccountRij>(
    `select
       a.id,
       c.slug as client_slug,
       c.naam as client_naam,
       a.eigenaar_naam,
       a.abonnement::text as abonnement,
       a.status::text as status,
       a.status_sinds,
       a.opbouw_factor,
       a.afkoeling_tot,
       a.unipile_account_id,
       a.tijdzone,
       a.openstaande_verzoeken
     from accounts a
     join clients c on c.id = a.client_id
     where c.actief = true
       and ($1::text is null or c.slug = $1)
     order by c.naam, a.eigenaar_naam`,
    [slug ?? null],
  );
  return {
    accounts: rijen.map((r) => ({
      accountId: r.id,
      clientSlug: r.client_slug,
      clientNaam: r.client_naam,
      eigenaarNaam: r.eigenaar_naam,
      abonnement: r.abonnement,
      status: r.status,
      statusSinds: alsIso(r.status_sinds),
      opbouwFactor: Number(r.opbouw_factor),
      afkoelingTot: r.afkoeling_tot ? alsIso(r.afkoeling_tot) : null,
      tijdzone: r.tijdzone,
      openstaandeVerzoeken: r.openstaande_verzoeken,
      unipileGekoppeld: r.unipile_account_id !== null,
    })),
  };
}

// -- account_health ----------------------------------------------------------

interface HealthRij {
  id: string;
  status: string;
  status_sinds: string | Date;
  opbouw_factor: string | number;
  afkoeling_tot: string | Date | null;
  tijdzone: string;
  openstaande_verzoeken: number;
  unipile_account_id: string | null;
}

async function accountHealth(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = vereistString(args, 'accountId');
  const rijen = await deps.db.query<HealthRij>(
    `select id, status::text as status, status_sinds, opbouw_factor,
            afkoeling_tot, tijdzone, openstaande_verzoeken, unipile_account_id
     from accounts where id = $1`,
    [accountId],
  );
  const rij = rijen[0];
  if (!rij) {
    throw new McpToolInvoerFout(
      `Onbekend account "${accountId}"; vraag eerst list_accounts op om het juiste id te vinden.`,
    );
  }
  const laatsteEvent = await deps.db.query<{
    type: string;
    ontvangen_op: string | Date;
    payload: Record<string, unknown> | string;
  }>(
    `select type, ontvangen_op, payload from events
     where account_id = $1
     order by ontvangen_op desc
     limit 5`,
    [accountId],
  );
  return {
    accountId: rij.id,
    status: rij.status,
    statusSinds: alsIso(rij.status_sinds),
    opbouwFactor: Number(rij.opbouw_factor),
    afkoelingTot: rij.afkoeling_tot ? alsIso(rij.afkoeling_tot) : null,
    tijdzone: rij.tijdzone,
    openstaandeVerzoeken: rij.openstaande_verzoeken,
    unipileGekoppeld: rij.unipile_account_id !== null,
    recenteEvents: laatsteEvent.map((e) => ({
      type: e.type,
      ontvangenOp: alsIso(e.ontvangen_op),
    })),
  };
}

// -- get_budget --------------------------------------------------------------

interface BudgetRij {
  id: string;
  abonnement: string;
  opbouw_factor: string | number;
  afkoeling_tot: string | Date | null;
  tijdzone: string;
  openstaande_verzoeken: number;
}

async function getBudget(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = vereistString(args, 'accountId');
  const rijen = await deps.db.query<BudgetRij>(
    `select id, abonnement::text as abonnement, opbouw_factor, afkoeling_tot, tijdzone,
            openstaande_verzoeken
     from accounts where id = $1`,
    [accountId],
  );
  const rij = rijen[0];
  if (!rij) {
    throw new McpToolInvoerFout(
      `Onbekend account "${accountId}"; vraag eerst list_accounts op om het juiste id te vinden.`,
    );
  }
  const abn = deps.limieten.abonnementen[rij.abonnement as keyof typeof deps.limieten.abonnementen];
  if (!abn) {
    throw new McpToolInvoerFout(
      `Abonnement "${rij.abonnement}" ontbreekt in de limieten-configuratie.`,
    );
  }
  const nu = deps.klok.nu();
  const vandaag = lokaleDag(nu, rij.tijdzone);
  const weekBereik = lokaleDagen(nu, rij.tijdzone, 7);
  const maandBereik = dagenInMaand(nu, rij.tijdzone);
  const factor = Number(rij.opbouw_factor);
  const afkoelingTot =
    rij.afkoeling_tot === null
      ? null
      : rij.afkoeling_tot instanceof Date
        ? rij.afkoeling_tot
        : new Date(rij.afkoeling_tot);
  // Tijdens afkoeling laat de budgetmotor niets door (SPEC §5, controle 6);
  // dan toont get_budget overal norm 0, zodat een skill niets inplant.
  const afkoeling = inAfkoeling({ afkoelingTot }, nu);

  const typen: ActieType[] = ['invite', 'message', 'profile', 'search'];
  const perType: Record<string, unknown> = {};
  for (const type of typen) {
    const dagGebruikt = await telGebruikOpDag(deps.db, accountId, type, vandaag);
    const weekGebruikt =
      type === 'search' ? 0 : await telGebruikOverDagen(deps.db, accountId, type, weekBereik);
    const dagnorm = afkoeling ? 0 : dagnormVoor(type, abn, factor);
    const geschaaldeWeeknorm = weeknormVoor(type, abn, factor);
    const weeknorm = afkoeling && geschaaldeWeeknorm !== null ? 0 : geschaaldeWeeknorm;
    perType[type] = {
      dag: {
        gebruikt: dagGebruikt,
        norm: dagnorm,
        resterend: Math.max(0, dagnorm - dagGebruikt),
      },
      week:
        weeknorm === null
          ? null
          : {
              gebruikt: weekGebruikt,
              norm: weeknorm,
              resterend: Math.max(0, weeknorm - weekGebruikt),
            },
    };
  }

  // InMail is betaald maandtegoed: geen opbouwfactor, alleen afkoeling zet het op 0.
  const inmailMaand = await telGebruikOverDagen(deps.db, accountId, 'inmail', maandBereik);
  const inmailNorm = afkoeling ? 0 : abn.inmail.maand;
  perType['inmail'] = {
    maand: {
      gebruikt: inmailMaand,
      norm: inmailNorm,
      resterend: Math.max(0, inmailNorm - inmailMaand),
    },
  };

  return {
    accountId: rij.id,
    abonnement: rij.abonnement,
    opbouwFactor: factor,
    afkoelingTot: afkoeling ? afkoelingTot!.toISOString() : null,
    ...(afkoeling
      ? {
          reden: `Account staat in afkoeling tot ${formatteerLokaal(afkoelingTot!, rij.tijdzone)} (${rij.tijdzone}), na 429, captcha of waarschuwing; tot dan gaat er niets naar LinkedIn. Plan pas na die tijd nieuwe acties in.`,
        }
      : {}),
    openstaandeVerzoeken: rij.openstaande_verzoeken,
    openstaandMaximum: abn.invite.openstaand_maximum,
    budget: perType,
  };
}

function dagnormVoor(type: ActieType, abn: AbonnementLimieten, factor: number): number {
  switch (type) {
    case 'invite':
      return geschaaldeNorm(abn.invite.dag, factor);
    case 'message':
      return geschaaldeNorm(abn.message.dag, factor);
    case 'profile':
      return geschaaldeNorm(abn.profile.dag, factor);
    case 'search':
      return geschaaldeNorm(abn.search.runs_per_dag, factor);
    case 'inmail':
      return 0;
  }
}

function weeknormVoor(type: ActieType, abn: AbonnementLimieten, factor: number): number | null {
  switch (type) {
    case 'invite':
      return weekBudgetMetBonus({
        invite: abn.invite,
        opbouwFactor: factor,
        wekenSindsStart: 0,
        acceptatieVerhouding: 0,
      });
    case 'message':
      return geschaaldeNorm(abn.message.week, factor);
    case 'profile':
      return geschaaldeNorm(abn.profile.week, factor);
    case 'search':
    case 'inmail':
      return null;
  }
}

// -- search_people -----------------------------------------------------------

async function searchPeople(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = vereistString(args, 'accountId');
  const payload: Record<string, unknown> = {};
  for (const veld of ['api', 'category', 'keywords', 'limit', 'cursor', 'filters']) {
    if (args[veld] !== undefined) payload[veld] = args[veld];
  }
  const ctx: SynchroonContext = {
    db: deps.db,
    unipile: deps.unipile,
    limieten: deps.limieten,
    klok: deps.klok,
    pauzeKiezer: deps.pauzeKiezer,
  };
  const uit = await voerSynchroonUit(ctx, { accountId, type: 'search', payload });
  return { actieId: uit.actieId, ...uit.response };
}

// -- get_profile -------------------------------------------------------------

async function getProfile(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = vereistString(args, 'accountId');
  const identifier = vereistString(args, 'identifier');
  const payload: Record<string, unknown> = { identifier };
  if (args['secties'] !== undefined) {
    if (typeof args['secties'] !== 'string') {
      throw new McpToolInvoerFout('Veld "secties" moet een tekst zijn.');
    }
    payload['secties'] = args['secties'];
  }
  const ctx: SynchroonContext = {
    db: deps.db,
    unipile: deps.unipile,
    limieten: deps.limieten,
    klok: deps.klok,
    pauzeKiezer: deps.pauzeKiezer,
  };
  const uit = await voerSynchroonUit(ctx, { accountId, type: 'profile', payload });
  return { actieId: uit.actieId, profiel: uit.response };
}

// -- queue_action ------------------------------------------------------------

const QUEUEBARE_TYPES: ReadonlySet<string> = new Set(['invite', 'message', 'inmail']);
const VERBODEN_GOEDKEUR_VELDEN: readonly string[] = [
  'approved',
  'goedgekeurd',
  'goedgekeurd_door',
  'goedgekeurdDoor',
  'status',
];

/**
 * Velden die iedere queue_action-payload moet bevatten zodat de
 * goedkeuringspagina een menselijke ontvanger kan tonen (naam, functie,
 * bedrijf, klikbare LinkedIn-link) en de "waarom" van de skill zichtbaar
 * is (SPEC §12, scope-wijziging 2026-10-01).
 */
const VERPLICHTE_PAYLOAD_VELDEN: readonly string[] = [
  'ontvanger_naam',
  'ontvanger_functie',
  'ontvanger_bedrijf',
  'ontvanger_url',
  'waarom',
];

async function queueAction(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = vereistString(args, 'accountId');
  const type = vereistString(args, 'type');
  if (!QUEUEBARE_TYPES.has(type)) {
    throw new McpToolInvoerFout(
      `Alleen invite, message en inmail kunnen via queue_action in de wachtrij; "${type}" niet. Gebruik search_people of get_profile voor directe uitvoering.`,
    );
  }
  const payload = args['payload'];
  if (!isObject(payload)) {
    throw new McpToolInvoerFout('Veld "payload" moet een object met de actievelden zijn.');
  }
  for (const veld of VERBODEN_GOEDKEUR_VELDEN) {
    if (Object.prototype.hasOwnProperty.call(args, veld) ||
        Object.prototype.hasOwnProperty.call(payload, veld)) {
      throw new McpToolInvoerFout(
        `Veld "${veld}" is niet toegestaan via de MCP: goedkeuring loopt uitsluitend via de goedkeuringspagina van de gateway (SPEC §12).`,
      );
    }
  }
  for (const veld of VERPLICHTE_PAYLOAD_VELDEN) {
    const w = payload[veld];
    if (typeof w !== 'string' || w.trim() === '') {
      throw new McpToolInvoerFout(
        `Veld "${veld}" is verplicht in de payload van queue_action (voor de goedkeuringspagina). Vul een niet-lege tekst in.`,
      );
    }
  }
  const url = payload['ontvanger_url'] as string;
  if (!isLinkedInUrl(url)) {
    throw new McpToolInvoerFout(
      `Veld "ontvanger_url" moet een linkedin.com-URL zijn (profiel of sales-navigator). Gaf: ${url}`,
    );
  }
  let geplandOp: Date | undefined;
  if (args['geplandOp'] !== undefined) {
    if (typeof args['geplandOp'] !== 'string') {
      throw new McpToolInvoerFout('Veld "geplandOp" moet een ISO-8601-tekst zijn.');
    }
    const d = new Date(args['geplandOp']);
    if (Number.isNaN(d.getTime())) {
      throw new McpToolInvoerFout('Veld "geplandOp" is geen geldige ISO-8601-datum.');
    }
    geplandOp = d;
  }
  const invoer: Parameters<typeof maakActie>[1] = {
    accountId,
    type: type as ActieType,
    payload,
  };
  if (geplandOp !== undefined) invoer.geplandOp = geplandOp;
  const actie = await maakActie(deps.db, invoer);
  return {
    actieId: actie.id,
    status: actie.status satisfies ActieStatus,
    bericht:
      'Actie staat als concept (draft) in de wachtrij. Keur hem goed via de goedkeuringspagina van de gateway voordat hij wordt verzonden.',
  };
}

function isLinkedInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

// -- start_sequence ----------------------------------------------------------

async function startSequenceTool(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = vereistString(args, 'accountId');
  const lead = args['lead'];
  if (!isObject(lead)) {
    throw new McpToolInvoerFout('Veld "lead" is verplicht en moet een object zijn.');
  }
  const teksten = args['teksten'];
  if (!isObject(teksten)) {
    throw new McpToolInvoerFout('Veld "teksten" is verplicht en moet een object zijn.');
  }
  const leadObj: Lead = {
    providerId: vereistString(lead, 'providerId'),
    naam: vereistString(lead, 'naam'),
    functie: vereistString(lead, 'functie'),
    bedrijf: vereistString(lead, 'bedrijf'),
    linkedinUrl: vereistString(lead, 'linkedinUrl'),
    waarom: vereistString(lead, 'waarom'),
  };
  if (!isLinkedInUrl(leadObj.linkedinUrl)) {
    throw new McpToolInvoerFout(
      `Veld "lead.linkedinUrl" moet een linkedin.com-URL zijn. Gaf: ${leadObj.linkedinUrl}`,
    );
  }
  const tekstenObj: SequentieTeksten = {
    invite: vereistString(teksten, 'invite'),
    bericht: vereistString(teksten, 'bericht'),
    opvolging: vereistString(teksten, 'opvolging'),
  };
  const inviteMax = deps.limieten.tekst_max_tekens.invite;
  const messageMax = deps.limieten.tekst_max_tekens.message;
  if (tekstenObj.invite.length > inviteMax) {
    throw new McpToolInvoerFout(
      `Veld "teksten.invite" is ${tekstenObj.invite.length} tekens; maximum is ${inviteMax}.`,
    );
  }
  if (tekstenObj.bericht.length > messageMax) {
    throw new McpToolInvoerFout(
      `Veld "teksten.bericht" is ${tekstenObj.bericht.length} tekens; maximum is ${messageMax}.`,
    );
  }
  if (tekstenObj.opvolging.length > messageMax) {
    throw new McpToolInvoerFout(
      `Veld "teksten.opvolging" is ${tekstenObj.opvolging.length} tekens; maximum is ${messageMax}.`,
    );
  }

  try {
    const uit = await startSequentie(deps.db, {
      accountId,
      lead: leadObj,
      teksten: tekstenObj,
    });
    return {
      sequentieId: uit.sequentie.id,
      status: uit.sequentie.status,
      invite: {
        actieId: uit.invite.id,
        status: uit.invite.status satisfies ActieStatus,
      },
      bericht:
        'Sequentie gestart. Alleen stap 1 (invite) is als concept aangemaakt — stap 2 en 3 worden pas door de tick aangemaakt na acceptatie en de wachttijden uit config/limits.json. Alle stappen vereisen goedkeuring via de goedkeuringspagina.',
    };
  } catch (err) {
    throw new McpToolInvoerFout((err as Error).message);
  }
}

// -- get_results -------------------------------------------------------------

interface ResultaatRij {
  id: string;
  account_id: string;
  type: string;
  status: string;
  reden: string | null;
  goedgekeurd_door: string | null;
  goedgekeurd_op: string | Date | null;
  gepland_op: string | Date | null;
  uitgevoerd_op: string | Date | null;
  aangemaakt_op: string | Date;
  sequence_id: string | null;
  sequence_stap: number | null;
}

async function getResults(deps: McpToolsDeps, args: Record<string, unknown>) {
  const accountId = args['accountId'];
  if (accountId !== undefined && typeof accountId !== 'string') {
    throw new McpToolInvoerFout('Veld "accountId" moet een tekst zijn.');
  }
  const limit = args['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
    throw new McpToolInvoerFout('Veld "limit" moet een positief geheel getal zijn.');
  }
  const max = Math.min(typeof limit === 'number' ? limit : 50, 200);
  const actieKolommen = `id, account_id, type::text as type, status::text as status,
            reden, goedgekeurd_door, goedgekeurd_op, gepland_op, uitgevoerd_op, aangemaakt_op,
            sequence_id, sequence_stap`;
  const rijen = accountId
    ? await deps.db.query<ResultaatRij>(
        `select ${actieKolommen} from actions
         where account_id = $1
         order by aangemaakt_op desc
         limit $2`,
        [accountId, max],
      )
    : await deps.db.query<ResultaatRij>(
        `select ${actieKolommen} from actions
         order by aangemaakt_op desc
         limit $1`,
        [max],
      );
  const eventTypen = ['new_relation', 'message_received', 'account_status', 'actie_onzeker'];
  const events = accountId
    ? await deps.db.query<{ type: string; ontvangen_op: string | Date }>(
        `select type, ontvangen_op from events
         where account_id = $1 and type = any($2::text[])
         order by ontvangen_op desc
         limit $3`,
        [accountId, eventTypen, max],
      )
    : await deps.db.query<{ type: string; ontvangen_op: string | Date }>(
        `select type, ontvangen_op from events
         where type = any($1::text[])
         order by ontvangen_op desc
         limit $2`,
        [eventTypen, max],
      );
  const sequentieKolommen = `id, account_id, lead_naam, lead_linkedin_url,
            stap, status::text as status, stop_reden,
            volgende_actie_op, aangemaakt_op`;
  const sequenties = accountId
    ? await deps.db.query<SequentieResultaatRij>(
        `select ${sequentieKolommen} from sequences
         where account_id = $1
         order by aangemaakt_op desc
         limit $2`,
        [accountId, max],
      )
    : await deps.db.query<SequentieResultaatRij>(
        `select ${sequentieKolommen} from sequences
         order by aangemaakt_op desc
         limit $1`,
        [max],
      );
  const sequentiePerId = new Map(sequenties.map((s) => [s.id, s]));
  const sequentieUit = await Promise.all(
    sequenties.map(async (s) => {
      const stappen = await lijstActiesVoorSequentie(deps.db, s.id);
      const laatste = stappen.length > 0 ? stappen[stappen.length - 1]! : null;
      return {
        sequentieId: s.id,
        accountId: s.account_id,
        leadNaam: s.lead_naam,
        leadLinkedinUrl: s.lead_linkedin_url,
        stap: s.stap,
        status: s.status,
        stopReden: s.stop_reden,
        volgendeActieOp: s.volgende_actie_op ? alsIso(s.volgende_actie_op) : null,
        aangemaaktOp: alsIso(s.aangemaakt_op),
        laatsteGebeurtenis: laatste
          ? {
              stap: laatste.stap,
              type: laatste.type,
              status: laatste.status,
              uitgevoerdOp: laatste.uitgevoerdOp ? laatste.uitgevoerdOp.toISOString() : null,
            }
          : null,
      };
    }),
  );
  return {
    acties: rijen.map((r) => {
      const seq = r.sequence_id ? sequentiePerId.get(r.sequence_id) : null;
      return {
        actieId: r.id,
        accountId: r.account_id,
        type: r.type,
        status: r.status,
        reden: r.reden,
        goedgekeurdDoor: r.goedgekeurd_door,
        goedgekeurdOp: r.goedgekeurd_op ? alsIso(r.goedgekeurd_op) : null,
        geplandOp: r.gepland_op ? alsIso(r.gepland_op) : null,
        uitgevoerdOp: r.uitgevoerd_op ? alsIso(r.uitgevoerd_op) : null,
        aangemaaktOp: alsIso(r.aangemaakt_op),
        sequentieId: r.sequence_id,
        sequentieStap: r.sequence_stap,
        sequentieGestartOp: seq ? alsIso(seq.aangemaakt_op) : null,
      };
    }),
    recenteEvents: events.map((e) => ({
      type: e.type,
      ontvangenOp: alsIso(e.ontvangen_op),
    })),
    sequenties: sequentieUit,
  };
}

interface SequentieResultaatRij {
  id: string;
  account_id: string;
  lead_naam: string | null;
  lead_linkedin_url: string;
  stap: number;
  status: string;
  stop_reden: string | null;
  volgende_actie_op: string | Date | null;
  aangemaakt_op: string | Date;
}

// -- hulpjes -----------------------------------------------------------------

function vereistString(args: Record<string, unknown>, veld: string): string {
  const waarde = args[veld];
  if (typeof waarde !== 'string' || waarde.trim() === '') {
    throw new McpToolInvoerFout(`Veld "${veld}" is verplicht en moet een niet-lege tekst zijn.`);
  }
  return waarde;
}

function isObject(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}

function alsIso(waarde: string | Date): string {
  return (waarde instanceof Date ? waarde : new Date(waarde)).toISOString();
}

export { McpSynchroonFout };
