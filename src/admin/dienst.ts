import type { Klok } from '../budget/klok.ts';
import { telGebruikOpDag, telGebruikOverDagen } from '../budget/gebruik.ts';
import type { AbonnementLimieten, ActieType, Limieten } from '../budget/limits.ts';
import { telInviteAlsOpenstaand } from '../budget/openstaand.ts';
import { geschaaldeNorm, weekBudgetMetBonus } from '../budget/opbouw.ts';
import { dagenInMaand, lokaleDag, lokaleDagen } from '../budget/tijdvenster.ts';
import type { Backend } from '../db/backend.ts';
import {
  keurActieGoed,
  vindActie,
  zetActieStatus,
  type Actie,
  type ActieStatus,
} from '../queue/acties.ts';
import type { Abonnement } from '../register/accounts.ts';
import { stopSequentieNaAfwijzing } from '../sequences/motor.ts';

/**
 * Dienstlaag voor de goedkeuringspagina (SPEC §12) en het klantportaal
 * (SPEC §14.3).
 *
 * Dit is de ENIGE plek in de code waar `goedkeurd_door` wordt gezet:
 * standaard `rubert` (admin), of `klant:<e-mail>` als het klantportaal een
 * `door` meegeeft (SPEC §14.1). Alle andere modules (planner, worker,
 * MCP-tools) laten het veld leeg of lezen het alleen. Zie
 * `admin/dienst.test.ts` voor de scan die deze regel afdwingt.
 */

export const GOEDKEURDER_RUBERT = 'rubert' as const;
export const GOEDKEURDER_KLANT_PREFIX = 'klant:' as const;

/** `klant:<e-mail>` voor `goedgekeurd_door`/`afgewezen_door` (SPEC §14.1). */
export function goedkeurderKlant(email: string): string {
  return `${GOEDKEURDER_KLANT_PREFIX}${email.trim().toLowerCase()}`;
}

export type AdminActieType = Extract<ActieType, 'invite' | 'message' | 'inmail'>;

export interface BudgetResterendPerType {
  dag?: { gebruikt: number; norm: number; resterend: number };
  week?: { gebruikt: number; norm: number; resterend: number };
  maand?: { gebruikt: number; norm: number; resterend: number };
}

export interface OntvangerWeergave {
  naam: string;
  functie: string;
  bedrijf: string;
  url: string;
  /** Technische verwijzing die klein onder de naam past (providerId, chatId of attendees). */
  technischeId: string;
}

export interface SequentieHerkomst {
  sequentieId: string;
  stap: number;
  totaalStappen: number;
  gestartOp: Date;
}

export interface DraftWeergave {
  actieId: string;
  accountId: string;
  eigenaarNaam: string;
  clientNaam: string;
  type: AdminActieType;
  ontvanger: OntvangerWeergave;
  tekst: string;
  tekenMax: number;
  waarom: string;
  aangemaaktDoorSkill: string;
  aangemaaktOp: Date;
  budget: BudgetResterendPerType;
  sequentie: SequentieHerkomst | null;
}

export interface OnzekerWeergave {
  actieId: string;
  accountId: string;
  eigenaarNaam: string;
  clientNaam: string;
  type: AdminActieType;
  ontvanger: OntvangerWeergave;
  tekst: string;
  waarom: string;
  reden: string | null;
  uitgevoerdOp: Date | null;
  aangemaaktOp: Date;
}

interface ActieRij {
  id: string;
  account_id: string;
  eigenaar_naam: string;
  client_naam: string;
  abonnement: string;
  opbouw_factor: string | number;
  tijdzone: string;
  type: ActieType;
  payload: Record<string, unknown> | string;
  status: ActieStatus;
  reden: string | null;
  uitgevoerd_op: string | Date | null;
  aangemaakt_op: string | Date;
  sequence_id: string | null;
  sequence_stap: number | null;
  sequentie_gestart_op: string | Date | null;
}

const LIJST_KOLOMMEN = `a.id, a.account_id, acc.eigenaar_naam, c.naam as client_naam,
    acc.abonnement::text as abonnement, acc.opbouw_factor, acc.tijdzone,
    a.type::text as type, a.payload, a.status::text as status, a.reden,
    a.uitgevoerd_op, a.aangemaakt_op,
    a.sequence_id, a.sequence_stap,
    s.aangemaakt_op as sequentie_gestart_op`;

const LIJST_FROM = `from actions a
    join accounts acc on acc.id = a.account_id
    join clients c on c.id = acc.client_id
    left join sequences s on s.id = a.sequence_id`;

export interface LijstDraftsOpties {
  limieten: Limieten;
  klok: Klok;
  accountId?: string;
  /** Alleen concepten van accounts van deze klant (klantportaal, SPEC §14.1). */
  clientId?: string;
}

export async function lijstDrafts(
  db: Backend,
  opties: LijstDraftsOpties,
): Promise<DraftWeergave[]> {
  const params: string[] = [];
  const filters: string[] = [];
  if (opties.accountId) {
    params.push(opties.accountId);
    filters.push(`and a.account_id = $${params.length}`);
  }
  if (opties.clientId) {
    params.push(opties.clientId);
    filters.push(`and acc.client_id = $${params.length}`);
  }
  const sql = `select ${LIJST_KOLOMMEN}
    ${LIJST_FROM}
    where a.status = 'draft'::action_status
      ${filters.join(' ')}
    order by a.aangemaakt_op asc`;
  const rijen = await db.query<ActieRij>(sql, params);
  const uit: DraftWeergave[] = [];
  for (const rij of rijen) {
    if (!isAdminType(rij.type)) continue; // search/profile horen hier niet.
    const payload = alsJson(rij.payload);
    uit.push({
      actieId: rij.id,
      accountId: rij.account_id,
      eigenaarNaam: rij.eigenaar_naam,
      clientNaam: rij.client_naam,
      type: rij.type as AdminActieType,
      ontvanger: ontvangerUitPayload(rij.type as AdminActieType, payload),
      tekst: tekstUitPayload(rij.type as AdminActieType, payload),
      tekenMax: tekenMaxVoorType(rij.type as AdminActieType, opties.limieten),
      waarom: waaromUitPayload(payload),
      aangemaaktDoorSkill: skillUitPayload(payload),
      aangemaaktOp: alsDatum(rij.aangemaakt_op),
      budget: await budgetVoorType(db, {
        accountId: rij.account_id,
        abonnement: rij.abonnement as Abonnement,
        opbouwFactor: Number(rij.opbouw_factor),
        tijdzone: rij.tijdzone,
        type: rij.type as AdminActieType,
        limieten: opties.limieten,
        klok: opties.klok,
      }),
      sequentie: sequentieHerkomstUit(rij),
    });
  }
  return uit;
}

function sequentieHerkomstUit(rij: ActieRij): SequentieHerkomst | null {
  if (!rij.sequence_id || rij.sequence_stap == null || !rij.sequentie_gestart_op) return null;
  return {
    sequentieId: rij.sequence_id,
    stap: rij.sequence_stap,
    totaalStappen: 3,
    gestartOp: alsDatum(rij.sequentie_gestart_op),
  };
}

export function tekenMaxVoorType(type: AdminActieType, limieten: Limieten): number {
  return limieten.tekst_max_tekens[type];
}

export async function lijstOnzeker(
  db: Backend,
  opties: { accountId?: string } = {},
): Promise<OnzekerWeergave[]> {
  const sql = `select ${LIJST_KOLOMMEN}
    ${LIJST_FROM}
    where a.status = 'onzeker'::action_status
      ${opties.accountId ? 'and a.account_id = $1' : ''}
    order by a.aangemaakt_op asc`;
  const rijen = opties.accountId
    ? await db.query<ActieRij>(sql, [opties.accountId])
    : await db.query<ActieRij>(sql);
  const uit: OnzekerWeergave[] = [];
  for (const rij of rijen) {
    if (!isAdminType(rij.type)) continue;
    const payload = alsJson(rij.payload);
    uit.push({
      actieId: rij.id,
      accountId: rij.account_id,
      eigenaarNaam: rij.eigenaar_naam,
      clientNaam: rij.client_naam,
      type: rij.type as AdminActieType,
      ontvanger: ontvangerUitPayload(rij.type as AdminActieType, payload),
      tekst: tekstUitPayload(rij.type as AdminActieType, payload),
      waarom: waaromUitPayload(payload),
      reden: rij.reden,
      uitgevoerdOp: rij.uitgevoerd_op ? alsDatum(rij.uitgevoerd_op) : null,
      aangemaaktOp: alsDatum(rij.aangemaakt_op),
    });
  }
  return uit;
}

export interface GoedkeurenOpties {
  nieuweTekst?: string;
  klok?: Klok;
  /**
   * Verplicht wanneer we tekstlengte willen controleren — in productie
   * altijd meegegeven; onze invariant is "server-side ook controleren,
   * nooit vertrouwen op JS-counter in de browser".
   */
  limieten?: Limieten;
  /** Wie keurt goed. Standaard `rubert`; het portaal geeft `klant:<e-mail>`. */
  door?: string;
}

export async function goedkeur(
  db: Backend,
  actieId: string,
  opts: GoedkeurenOpties = {},
): Promise<Actie> {
  if (opts.nieuweTekst !== undefined) {
    await werkTekstBij(db, actieId, opts.nieuweTekst, opts.limieten);
  } else if (opts.limieten) {
    await controleerBestaandeTekst(db, actieId, opts.limieten);
  }
  const nu = opts.klok?.nu() ?? new Date();
  return await keurActieGoed(db, actieId, opts.door ?? GOEDKEURDER_RUBERT, nu);
}

export interface GoedkeurBatchResultaat {
  goedgekeurd: string[];
  overgeslagen: Array<{ actieId: string; reden: string }>;
}

export async function goedkeurBatch(
  db: Backend,
  actieIds: readonly string[],
  opts: { klok?: Klok; door?: string; limieten?: Limieten } = {},
): Promise<GoedkeurBatchResultaat> {
  const resultaat: GoedkeurBatchResultaat = { goedgekeurd: [], overgeslagen: [] };
  for (const id of actieIds) {
    try {
      // Met limieten (portaal): zelfde tekstcontrole als bij losse goedkeuring.
      if (opts.limieten) await controleerBestaandeTekst(db, id, opts.limieten);
      const nu = opts.klok?.nu() ?? new Date();
      await keurActieGoed(db, id, opts.door ?? GOEDKEURDER_RUBERT, nu);
      resultaat.goedgekeurd.push(id);
    } catch (err) {
      resultaat.overgeslagen.push({ actieId: id, reden: (err as Error).message });
    }
  }
  return resultaat;
}

/**
 * Wijst een actie af. Hoort de actie bij een sequentie, dan stopt die
 * sequentie in dezelfde transactie (SPEC §8a), zodat de lead daarna met een
 * verbeterde tekst opnieuw gestart kan worden.
 */
export async function wijsAf(
  db: Backend,
  actieId: string,
  reden: string,
  opts: { limieten: Limieten; door?: string },
): Promise<Actie> {
  const door = opts.door ?? GOEDKEURDER_RUBERT;
  const schoongemaakt = reden.trim();
  if (!schoongemaakt) {
    throw new Error('Reden voor afwijzen is verplicht.');
  }
  const actie = await vindActie(db, actieId);
  if (!actie) throw new Error(`Actie ${actieId} bestaat niet.`);
  if (actie.status !== 'draft' && actie.status !== 'queued' && actie.status !== 'onzeker') {
    throw new Error(
      `Actie ${actieId} kan niet worden afgewezen vanuit status "${actie.status}".`,
    );
  }
  return await db.transaction(async (tx) => {
    const afgewezen = await zetActieStatus(tx, actieId, 'rejected', {
      reden: schoongemaakt,
      afgewezenDoor: door,
    });
    await stopSequentieNaAfwijzing(tx, opts.limieten, { actieId, reden: schoongemaakt, door });
    return afgewezen;
  });
}

export async function markeerOnzekerAlsDone(
  db: Backend,
  actieId: string,
  klok?: Klok,
): Promise<Actie> {
  const actie = await vindActie(db, actieId);
  if (!actie) throw new Error(`Actie ${actieId} bestaat niet.`);
  if (actie.status !== 'onzeker') {
    throw new Error(
      `Actie ${actieId} is niet 'onzeker' (huidige status: "${actie.status}"); kan niet handmatig op done gezet worden.`,
    );
  }
  const nu = klok?.nu() ?? new Date();
  return await db.transaction(async (tx) => {
    const klaar = await zetActieStatus(tx, actieId, 'done', {
      reden: 'Handmatig op done gezet door Rubert na controle in LinkedIn.',
      uitgevoerdOp: nu,
    });
    // Telde normaal al mee bij 'onzeker'; alleen oude onzeker-acties tellen nu.
    if (klaar.type === 'invite') await telInviteAlsOpenstaand(tx, klaar);
    return klaar;
  });
}

export async function herapproveOnzeker(
  db: Backend,
  actieId: string,
  klok?: Klok,
): Promise<Actie> {
  const actie = await vindActie(db, actieId);
  if (!actie) throw new Error(`Actie ${actieId} bestaat niet.`);
  if (actie.status !== 'onzeker') {
    throw new Error(
      `Actie ${actieId} is niet 'onzeker' (huidige status: "${actie.status}"); gebruik goedkeur voor andere statussen.`,
    );
  }
  const nu = klok?.nu() ?? new Date();
  return await keurActieGoed(db, actieId, GOEDKEURDER_RUBERT, nu);
}

// -- hulpjes ----------------------------------------------------------------

function isAdminType(type: string): type is AdminActieType {
  return type === 'invite' || type === 'message' || type === 'inmail';
}

function alsJson(w: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!w) return {};
  if (typeof w === 'string') {
    try {
      return JSON.parse(w) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return w;
}

function alsDatum(w: string | Date): Date {
  return w instanceof Date ? w : new Date(w);
}

function ontvangerUitPayload(
  type: AdminActieType,
  p: Record<string, unknown>,
): OntvangerWeergave {
  return {
    naam: tekstVeld(p, 'ontvanger_naam'),
    functie: tekstVeld(p, 'ontvanger_functie'),
    bedrijf: tekstVeld(p, 'ontvanger_bedrijf'),
    url: tekstVeld(p, 'ontvanger_url'),
    technischeId: technischeIdVoor(type, p),
  };
}

function tekstVeld(p: Record<string, unknown>, naam: string): string {
  const w = p[naam];
  return typeof w === 'string' && w.trim() !== '' ? w : '—';
}

function technischeIdVoor(type: AdminActieType, p: Record<string, unknown>): string {
  switch (type) {
    case 'invite':
      return (p['providerId'] as string) ?? (p['userEmail'] as string) ?? '—';
    case 'message':
      return (p['chatId'] as string) ?? '—';
    case 'inmail': {
      const ids = p['attendeesIds'];
      if (Array.isArray(ids)) return ids.join(', ');
      return '—';
    }
  }
}

function waaromUitPayload(p: Record<string, unknown>): string {
  const w = p['waarom'];
  return typeof w === 'string' && w.trim() !== '' ? w : '—';
}

function tekstUitPayload(type: AdminActieType, p: Record<string, unknown>): string {
  switch (type) {
    case 'invite':
      return (p['message'] as string) ?? '';
    case 'message':
      return (p['tekst'] as string) ?? '';
    case 'inmail': {
      const o = p['onderwerp'] as string | undefined;
      const t = (p['tekst'] as string) ?? '';
      return o ? `${o}\n\n${t}` : t;
    }
  }
}

/**
 * Welke skill de actie heeft aangemaakt. Conventie: skills zetten een
 * `_skill`-veld in de payload. Ontbreekt het, dan tonen we "onbekend"
 * (nieuwe skills krijgen de instructie om dit mee te sturen).
 */
function skillUitPayload(p: Record<string, unknown>): string {
  const naam = p['_skill'] ?? p['skill'];
  if (typeof naam === 'string' && naam.trim() !== '') return naam.trim();
  return 'onbekend';
}

async function werkTekstBij(
  db: Backend,
  actieId: string,
  nieuweTekst: string,
  limieten?: Limieten,
): Promise<void> {
  const actie = await vindActie(db, actieId);
  if (!actie) throw new Error(`Actie ${actieId} bestaat niet.`);
  if (actie.status !== 'draft') {
    throw new Error(
      `Actie ${actieId} heeft status "${actie.status}"; tekst alleen aan te passen op drafts.`,
    );
  }
  if (!isAdminType(actie.type)) {
    throw new Error(
      `Tekst aanpassen wordt niet ondersteund voor actietype "${actie.type}".`,
    );
  }
  const schoon = nieuweTekst.trim();
  if (limieten) {
    const max = tekenMaxVoorType(actie.type, limieten);
    if (schoon.length > max) {
      throw new Error(
        `Tekst is ${schoon.length} tekens; maximum voor ${actie.type} is ${max} tekens. Korter maken vóór goedkeuren.`,
      );
    }
  }
  const nieuwePayload = { ...actie.payload };
  if (actie.type === 'invite') nieuwePayload['message'] = schoon;
  else if (actie.type === 'message') nieuwePayload['tekst'] = schoon;
  else if (actie.type === 'inmail') nieuwePayload['tekst'] = schoon;
  await db.query(
    `update actions set payload = $2::jsonb where id = $1`,
    [actieId, JSON.stringify(nieuwePayload)],
  );
}

async function controleerBestaandeTekst(
  db: Backend,
  actieId: string,
  limieten: Limieten,
): Promise<void> {
  const actie = await vindActie(db, actieId);
  if (!actie) throw new Error(`Actie ${actieId} bestaat niet.`);
  if (!isAdminType(actie.type)) return;
  const payload = actie.payload as Record<string, unknown>;
  const tekst = tekstUitPayload(actie.type, payload);
  const max = tekenMaxVoorType(actie.type, limieten);
  if (tekst.length > max) {
    throw new Error(
      `Tekst is ${tekst.length} tekens; maximum voor ${actie.type} is ${max} tekens. Korter maken vóór goedkeuren.`,
    );
  }
}

interface BudgetInvoer {
  accountId: string;
  abonnement: Abonnement;
  opbouwFactor: number;
  tijdzone: string;
  type: AdminActieType;
  limieten: Limieten;
  klok: Klok;
}

async function budgetVoorType(
  db: Backend,
  inv: BudgetInvoer,
): Promise<BudgetResterendPerType> {
  const abn = inv.limieten.abonnementen[inv.abonnement];
  if (!abn) {
    throw new Error(`Abonnement "${inv.abonnement}" ontbreekt in de limieten-configuratie.`);
  }
  const nu = inv.klok.nu();
  if (inv.type === 'inmail') {
    const maandBereik = dagenInMaand(nu, inv.tijdzone);
    const gebruikt = await telGebruikOverDagen(db, inv.accountId, 'inmail', maandBereik);
    const norm = abn.inmail.maand;
    return {
      maand: { gebruikt, norm, resterend: Math.max(0, norm - gebruikt) },
    };
  }
  const dag = lokaleDag(nu, inv.tijdzone);
  const weekBereik = lokaleDagen(nu, inv.tijdzone, 7);
  const dagGebruikt = await telGebruikOpDag(db, inv.accountId, inv.type, dag);
  const weekGebruikt = await telGebruikOverDagen(db, inv.accountId, inv.type, weekBereik);
  const dagnorm = dagnormVoor(inv.type, abn, inv.opbouwFactor);
  const weeknorm = weeknormVoor(inv.type, abn, inv.opbouwFactor);
  return {
    dag: {
      gebruikt: dagGebruikt,
      norm: dagnorm,
      resterend: Math.max(0, dagnorm - dagGebruikt),
    },
    week: {
      gebruikt: weekGebruikt,
      norm: weeknorm,
      resterend: Math.max(0, weeknorm - weekGebruikt),
    },
  };
}

function dagnormVoor(type: 'invite' | 'message', abn: AbonnementLimieten, factor: number): number {
  switch (type) {
    case 'invite':
      return geschaaldeNorm(abn.invite.dag, factor);
    case 'message':
      return geschaaldeNorm(abn.message.dag, factor);
  }
}

function weeknormVoor(type: 'invite' | 'message', abn: AbonnementLimieten, factor: number): number {
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
  }
}
