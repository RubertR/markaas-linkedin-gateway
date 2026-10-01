import type { Backend } from '../db/backend.ts';

import type { ActieType } from './limits.ts';

/**
 * Verhoogt (of maakt) de tellerrij voor (account, type, dag). Dag is een
 * lokale kalenderdag in de tijdzone van het account (SPEC §5, docs/fase-2-plan §3.3).
 */
export async function verhoogGebruik(
  db: Backend,
  accountId: string,
  type: ActieType,
  dag: string,
  aantal = 1,
): Promise<void> {
  if (!Number.isInteger(aantal) || aantal <= 0) {
    throw new Error(`Aantal moet een positief geheel getal zijn (gaf ${aantal}).`);
  }
  await db.query(
    `insert into usage(account_id, type, dag, aantal)
     values ($1, $2::action_type, $3::date, $4)
     on conflict (account_id, type, dag)
     do update set aantal = usage.aantal + excluded.aantal`,
    [accountId, type, dag, aantal],
  );
}

export async function telGebruikOpDag(
  db: Backend,
  accountId: string,
  type: ActieType,
  dag: string,
): Promise<number> {
  const rijen = await db.query<{ aantal: number | string }>(
    `select aantal from usage
     where account_id = $1 and type = $2::action_type and dag = $3::date`,
    [accountId, type, dag],
  );
  const rij = rijen[0];
  if (!rij) return 0;
  return typeof rij.aantal === 'string' ? Number(rij.aantal) : rij.aantal;
}

export async function telGebruikOverDagen(
  db: Backend,
  accountId: string,
  type: ActieType,
  dagen: readonly string[],
): Promise<number> {
  if (dagen.length === 0) return 0;
  const rijen = await db.query<{ som: number | string | null }>(
    `select coalesce(sum(aantal), 0) as som from usage
     where account_id = $1 and type = $2::action_type
       and dag = any($3::date[])`,
    [accountId, type, dagen],
  );
  const rij = rijen[0];
  if (!rij || rij.som === null) return 0;
  return typeof rij.som === 'string' ? Number(rij.som) : rij.som;
}
