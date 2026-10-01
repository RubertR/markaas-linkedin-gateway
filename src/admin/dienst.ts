import type { Klok } from '../budget/klok.ts';
import { telGebruikOpDag, telGebruikOverDagen } from '../budget/gebruik.ts';
import type { AbonnementLimieten, ActieType, Limieten } from '../budget/limits.ts';
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

/**
 * Dienstlaag voor de goedkeuringspagina (SPEC §12).
 *
 * Dit is de ENIGE plek in de code waar `goedkeurd_door = 'rubert'` wordt
 * gezet. Alle andere modules (planner, worker, MCP-tools) laten het veld
 * leeg of lezen het alleen. Zie `admin/dienst.test.ts` voor de scan die
 * deze regel afdwingt.
 */

export const GOEDKEURDER_RUBERT = 'rubert' as const;

export type AdminActieType = Extract<ActieType, 'invite' | 'message' | 'inmail'>;

export interface BudgetResterendPerType {
  dag?: { gebruikt: number; norm: number; resterend: number };
  week?: { gebruikt: number; norm: number; resterend: number };
  maand?: { gebruikt: number; norm: number; resterend: number };
}

export interface DraftWeergave {
  actieId: string;
  accountId: string;
  eigenaarNaam: string;
  clientNaam: string;
  type: AdminActieType;
  ontvanger: string;
  tekst: string;
  aangemaaktDoorSkill: string;
  aangemaaktOp: Date;
  budget: BudgetResterendPerType;
}

export interface OnzekerWeergave {
  actieId: string;
  accountId: string;
  eigenaarNaam: string;
  clientNaam: string;
  type: AdminActieType;
  ontvanger: string;
  tekst: string;
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
}

const LIJST_KOLOMMEN = `a.id, a.account_id, acc.eigenaar_naam, c.naam as client_naam,
    acc.abonnement::text as abonnement, acc.opbouw_factor, acc.tijdzone,
    a.type::text as type, a.payload, a.status::text as status, a.reden,
    a.uitgevoerd_op, a.aangemaakt_op`;

export interface LijstDraftsOpties {
  limieten: Limieten;
  klok: Klok;
  accountId?: string;
}

export async function lijstDrafts(
  db: Backend,
  opties: LijstDraftsOpties,
): Promise<DraftWeergave[]> {
  const sql = `select ${LIJST_KOLOMMEN}
    from actions a
    join accounts acc on acc.id = a.account_id
    join clients c on c.id = acc.client_id
    where a.status = 'draft'::action_status
      ${opties.accountId ? 'and a.account_id = $1' : ''}
    order by a.aangemaakt_op asc`;
  const rijen = opties.accountId
    ? await db.query<ActieRij>(sql, [opties.accountId])
    : await db.query<ActieRij>(sql);
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
    });
  }
  return uit;
}

export async function lijstOnzeker(
  db: Backend,
  opties: { accountId?: string } = {},
): Promise<OnzekerWeergave[]> {
  const sql = `select ${LIJST_KOLOMMEN}
    from actions a
    join accounts acc on acc.id = a.account_id
    join clients c on c.id = acc.client_id
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
}

export async function goedkeur(
  db: Backend,
  actieId: string,
  opts: GoedkeurenOpties = {},
): Promise<Actie> {
  if (opts.nieuweTekst !== undefined) {
    await werkTekstBij(db, actieId, opts.nieuweTekst);
  }
  const nu = opts.klok?.nu() ?? new Date();
  return await keurActieGoed(db, actieId, GOEDKEURDER_RUBERT, nu);
}

export interface GoedkeurBatchResultaat {
  goedgekeurd: string[];
  overgeslagen: Array<{ actieId: string; reden: string }>;
}

export async function goedkeurBatch(
  db: Backend,
  actieIds: readonly string[],
  opts: { klok?: Klok } = {},
): Promise<GoedkeurBatchResultaat> {
  const resultaat: GoedkeurBatchResultaat = { goedgekeurd: [], overgeslagen: [] };
  for (const id of actieIds) {
    try {
      const nu = opts.klok?.nu() ?? new Date();
      await keurActieGoed(db, id, GOEDKEURDER_RUBERT, nu);
      resultaat.goedgekeurd.push(id);
    } catch (err) {
      resultaat.overgeslagen.push({ actieId: id, reden: (err as Error).message });
    }
  }
  return resultaat;
}

export async function wijsAf(db: Backend, actieId: string, reden: string): Promise<Actie> {
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
  return await zetActieStatus(db, actieId, 'rejected', { reden: schoongemaakt });
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
  return await zetActieStatus(db, actieId, 'done', {
    reden: 'Handmatig op done gezet door Rubert na controle in LinkedIn.',
    uitgevoerdOp: nu,
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

function ontvangerUitPayload(type: AdminActieType, p: Record<string, unknown>): string {
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

async function werkTekstBij(db: Backend, actieId: string, nieuweTekst: string): Promise<void> {
  const actie = await vindActie(db, actieId);
  if (!actie) throw new Error(`Actie ${actieId} bestaat niet.`);
  if (actie.status !== 'draft') {
    throw new Error(
      `Actie ${actieId} heeft status "${actie.status}"; tekst alleen aan te passen op drafts.`,
    );
  }
  const schoon = nieuweTekst.trim();
  const nieuwePayload = { ...actie.payload };
  if (actie.type === 'invite') nieuwePayload['message'] = schoon;
  else if (actie.type === 'message') nieuwePayload['tekst'] = schoon;
  else if (actie.type === 'inmail') nieuwePayload['tekst'] = schoon;
  else {
    throw new Error(
      `Tekst aanpassen wordt niet ondersteund voor actietype "${actie.type}".`,
    );
  }
  await db.query(
    `update actions set payload = $2::jsonb where id = $1`,
    [actieId, JSON.stringify(nieuwePayload)],
  );
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
