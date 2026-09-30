import type { Backend } from '../db/backend.ts';

import type { AccountStatus } from './status.ts';

export type Abonnement =
  | 'free'
  | 'premium_career'
  | 'premium_business'
  | 'salesnav_core'
  | 'salesnav_advanced';

export interface Account {
  id: string;
  clientId: string;
  eigenaarNaam: string;
  unipileAccountId: string | null;
  abonnement: Abonnement;
  status: AccountStatus;
  statusSinds: Date;
  opbouwFactor: number;
  afkoelingTot: Date | null;
  tijdzone: string;
  openstaandeVerzoeken: number;
  aangemaaktOp: Date;
}

export interface RegistreerAccountInvoer {
  clientId: string;
  eigenaarNaam: string;
  abonnement: Abonnement;
  tijdzone?: string;
}

interface AccountRij {
  id: string;
  client_id: string;
  eigenaar_naam: string;
  unipile_account_id: string | null;
  abonnement: Abonnement;
  status: AccountStatus;
  status_sinds: string | Date;
  opbouw_factor: string | number;
  afkoeling_tot: string | Date | null;
  tijdzone: string;
  openstaande_verzoeken: number;
  aangemaakt_op: string | Date;
}

function alsDatum(waarde: string | Date): Date {
  return waarde instanceof Date ? waarde : new Date(waarde);
}

function alsDatumOfNull(waarde: string | Date | null): Date | null {
  if (waarde === null) return null;
  return alsDatum(waarde);
}

function map(rij: AccountRij): Account {
  return {
    id: rij.id,
    clientId: rij.client_id,
    eigenaarNaam: rij.eigenaar_naam,
    unipileAccountId: rij.unipile_account_id,
    abonnement: rij.abonnement,
    status: rij.status,
    statusSinds: alsDatum(rij.status_sinds),
    opbouwFactor: typeof rij.opbouw_factor === 'string' ? Number(rij.opbouw_factor) : rij.opbouw_factor,
    afkoelingTot: alsDatumOfNull(rij.afkoeling_tot),
    tijdzone: rij.tijdzone,
    openstaandeVerzoeken: rij.openstaande_verzoeken,
    aangemaaktOp: alsDatum(rij.aangemaakt_op),
  };
}

const KOLOMMEN = `id, client_id, eigenaar_naam, unipile_account_id, abonnement,
    status, status_sinds, opbouw_factor, afkoeling_tot, tijdzone,
    openstaande_verzoeken, aangemaakt_op`;

export async function registreerAccount(
  db: Backend,
  invoer: RegistreerAccountInvoer,
): Promise<Account> {
  const rijen = await db.query<AccountRij>(
    `insert into accounts(client_id, eigenaar_naam, abonnement, tijdzone)
     values ($1, $2, $3, coalesce($4, 'Europe/Amsterdam'))
     returning ${KOLOMMEN}`,
    [invoer.clientId, invoer.eigenaarNaam, invoer.abonnement, invoer.tijdzone ?? null],
  );
  const rij = rijen[0];
  if (!rij) throw new Error('Account aanmaken gaf geen rij terug.');
  return map(rij);
}

export async function vindAccount(db: Backend, id: string): Promise<Account | null> {
  const rijen = await db.query<AccountRij>(
    `select ${KOLOMMEN} from accounts where id = $1`,
    [id],
  );
  return rijen[0] ? map(rijen[0]) : null;
}

export async function vindAccountBijUnipileId(
  db: Backend,
  unipileAccountId: string,
): Promise<Account | null> {
  const rijen = await db.query<AccountRij>(
    `select ${KOLOMMEN} from accounts where unipile_account_id = $1`,
    [unipileAccountId],
  );
  return rijen[0] ? map(rijen[0]) : null;
}

export async function markeerAccountGekoppeld(
  db: Backend,
  id: string,
  unipileAccountId: string,
): Promise<void> {
  try {
    await db.query(
      `update accounts
       set unipile_account_id = $2, status = 'OK', status_sinds = now()
       where id = $1`,
      [id, unipileAccountId],
    );
  } catch (err) {
    const bericht = (err as Error)?.message ?? '';
    if (/duplicate|unique/i.test(bericht) && bericht.includes('unipile_account_id')) {
      throw new Error(
        `Unipile-account-id "${unipileAccountId}" bestaat al bij een ander account; koppeling geweigerd.`,
      );
    }
    throw err;
  }
}

export interface WerkStatusOpties {
  afkoelingTotWissen?: boolean;
}

export async function werkAccountStatusBij(
  db: Backend,
  id: string,
  status: AccountStatus,
  opties: WerkStatusOpties = {},
): Promise<void> {
  if (opties.afkoelingTotWissen) {
    await db.query(
      `update accounts
       set status = $2::account_status, status_sinds = now(), afkoeling_tot = null
       where id = $1`,
      [id, status],
    );
  } else {
    await db.query(
      `update accounts
       set status = $2::account_status, status_sinds = now()
       where id = $1`,
      [id, status],
    );
  }
}
