import type { Backend } from '../db/backend.ts';
import type { ActieType } from '../budget/limits.ts';

export type ActieStatus =
  | 'draft'
  | 'approved'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'rejected';

export interface Actie {
  id: string;
  accountId: string;
  type: ActieType;
  payload: Record<string, unknown>;
  status: ActieStatus;
  reden: string | null;
  goedgekeurdDoor: string | null;
  goedgekeurdOp: Date | null;
  geplandOp: Date | null;
  uitgevoerdOp: Date | null;
  unipileResponse: Record<string, unknown> | null;
  aangemaaktOp: Date;
}

interface ActieRij {
  id: string;
  account_id: string;
  type: ActieType;
  payload: Record<string, unknown> | string;
  status: ActieStatus;
  reden: string | null;
  goedgekeurd_door: string | null;
  goedgekeurd_op: string | Date | null;
  gepland_op: string | Date | null;
  uitgevoerd_op: string | Date | null;
  unipile_response: Record<string, unknown> | string | null;
  aangemaakt_op: string | Date;
}

function alsDatum(waarde: string | Date): Date {
  return waarde instanceof Date ? waarde : new Date(waarde);
}

function alsDatumOfNull(waarde: string | Date | null): Date | null {
  return waarde == null ? null : alsDatum(waarde);
}

function alsJson(waarde: Record<string, unknown> | string | null): Record<string, unknown> | null {
  if (waarde === null) return null;
  if (typeof waarde === 'string') return JSON.parse(waarde);
  return waarde;
}

function map(rij: ActieRij): Actie {
  const payload = alsJson(rij.payload as Record<string, unknown> | string | null);
  return {
    id: rij.id,
    accountId: rij.account_id,
    type: rij.type,
    payload: payload ?? {},
    status: rij.status,
    reden: rij.reden,
    goedgekeurdDoor: rij.goedgekeurd_door,
    goedgekeurdOp: alsDatumOfNull(rij.goedgekeurd_op),
    geplandOp: alsDatumOfNull(rij.gepland_op),
    uitgevoerdOp: alsDatumOfNull(rij.uitgevoerd_op),
    unipileResponse: alsJson(rij.unipile_response),
    aangemaaktOp: alsDatum(rij.aangemaakt_op),
  };
}

const KOLOMMEN = `id, account_id, type, payload, status, reden,
    goedgekeurd_door, goedgekeurd_op, gepland_op, uitgevoerd_op,
    unipile_response, aangemaakt_op`;

const VEREIST_GOEDKEURING: ReadonlySet<ActieType> = new Set(['invite', 'message', 'inmail']);
const EINDSTATUSSEN: ReadonlySet<ActieStatus> = new Set(['done', 'failed', 'rejected']);

export interface MaakActieInvoer {
  accountId: string;
  type: ActieType;
  payload: Record<string, unknown>;
  /**
   * Alleen voor search/profile: zet de actie meteen op "approved" zodat
   * de planner haar oppakt zonder menselijke goedkeuring (SPEC §5 controle 2).
   */
  directApproved?: boolean;
  geplandOp?: Date;
}

export async function maakActie(db: Backend, invoer: MaakActieInvoer): Promise<Actie> {
  if (invoer.directApproved && VEREIST_GOEDKEURING.has(invoer.type)) {
    throw new Error(
      `Actietype "${invoer.type}" vereist menselijke goedkeuring; directApproved is alleen toegestaan voor search en profile.`,
    );
  }
  const status: ActieStatus = invoer.directApproved ? 'approved' : 'draft';
  const rijen = await db.query<ActieRij>(
    `insert into actions(account_id, type, payload, status, gepland_op)
     values ($1, $2::action_type, $3::jsonb, $4::action_status, $5)
     returning ${KOLOMMEN}`,
    [
      invoer.accountId,
      invoer.type,
      JSON.stringify(invoer.payload ?? {}),
      status,
      invoer.geplandOp ? invoer.geplandOp.toISOString() : null,
    ],
  );
  const rij = rijen[0];
  if (!rij) throw new Error('Actie aanmaken gaf geen rij terug.');
  return map(rij);
}

export async function vindActie(db: Backend, id: string): Promise<Actie | null> {
  const rijen = await db.query<ActieRij>(
    `select ${KOLOMMEN} from actions where id = $1`,
    [id],
  );
  return rijen[0] ? map(rijen[0]) : null;
}

export async function keurActieGoed(
  db: Backend,
  actieId: string,
  door: string,
  nu: Date = new Date(),
): Promise<Actie> {
  const rijen = await db.query<ActieRij>(
    `update actions
     set status = 'approved'::action_status,
         goedgekeurd_door = $2,
         goedgekeurd_op = $3
     where id = $1
       and status in ('draft'::action_status, 'queued'::action_status)
     returning ${KOLOMMEN}`,
    [actieId, door, nu.toISOString()],
  );
  const rij = rijen[0];
  if (!rij) {
    const bestaand = await vindActie(db, actieId);
    if (!bestaand) throw new Error(`Actie ${actieId} bestaat niet.`);
    throw new Error(
      `Actie ${actieId} kan niet goedgekeurd worden vanuit status "${bestaand.status}".`,
    );
  }
  return map(rij);
}

export interface StatusOpties {
  reden?: string | null;
  geplandOp?: Date | null;
  uitgevoerdOp?: Date | null;
  unipileResponse?: Record<string, unknown> | null;
}

export async function zetActieStatus(
  db: Backend,
  actieId: string,
  status: ActieStatus,
  opties: StatusOpties = {},
): Promise<Actie> {
  const sets: string[] = ['status = $2::action_status'];
  const params: unknown[] = [actieId, status];

  if (Object.prototype.hasOwnProperty.call(opties, 'reden')) {
    params.push(opties.reden ?? null);
    sets.push(`reden = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(opties, 'geplandOp')) {
    params.push(opties.geplandOp ? opties.geplandOp.toISOString() : null);
    sets.push(`gepland_op = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(opties, 'uitgevoerdOp')) {
    params.push(opties.uitgevoerdOp ? opties.uitgevoerdOp.toISOString() : null);
    sets.push(`uitgevoerd_op = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(opties, 'unipileResponse')) {
    params.push(opties.unipileResponse ? JSON.stringify(opties.unipileResponse) : null);
    sets.push(`unipile_response = $${params.length}::jsonb`);
  }

  const rijen = await db.query<ActieRij>(
    `update actions set ${sets.join(', ')} where id = $1 returning ${KOLOMMEN}`,
    params,
  );
  const rij = rijen[0];
  if (!rij) throw new Error(`Actie ${actieId} bestaat niet.`);
  return map(rij);
}

export function isEindstatus(status: ActieStatus): boolean {
  return EINDSTATUSSEN.has(status);
}

export function vereistGoedkeuring(type: ActieType): boolean {
  return VEREIST_GOEDKEURING.has(type);
}
