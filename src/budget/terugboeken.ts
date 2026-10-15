import type { Backend } from '../db/backend.ts';
import { vindAccount } from '../register/accounts.ts';

import type { ActieType } from './limits.ts';
import { lokaleDag } from './tijdvenster.ts';

/**
 * Terugboeken van een reservering als vaststaat dat de aanvraag LinkedIn niet
 * heeft bereikt (SPEC §5.1). Roep aan binnen dezelfde transactie als de
 * statuswijziging van de actie naar `failed`.
 *
 * - Verlaagt de `usage`-rij van de lokale dag van het account met 1, nooit onder 0.
 *   De reservering en de uitvoering vallen binnen het tijdvenster van dezelfde
 *   werkdag (§5 controle 5), dus de dag van nu is de dag van de reservering.
 * - Zet `teruggeboekt_op` op de actie; een actie wordt hoogstens één keer teruggeboekt.
 * - Hoogstens `maxPerDagPerType` terugboekingen per account, type en lokale dag;
 *   daarboven telt de weigering wel mee en geeft deze functie `false`.
 */
export interface TerugboekInvoer {
  accountId: string;
  actieId: string;
  type: ActieType;
  nu: Date;
  maxPerDagPerType: number;
}

export async function boekTerug(db: Backend, invoer: TerugboekInvoer): Promise<boolean> {
  if (invoer.maxPerDagPerType <= 0) return false;

  // Vergrendel de accountrij, zodat twee gelijktijdige terugboekingen de grens
  // niet samen kunnen overschrijden (zelfde slot als reserveerEnVerbruik).
  await db.query(`select 1 from accounts where id = $1 for update`, [invoer.accountId]);
  const account = await vindAccount(db, invoer.accountId);
  if (!account) return false;

  const dag = lokaleDag(invoer.nu, account.tijdzone);
  const eerder = await db.query<{ teruggeboekt_op: string | Date }>(
    `select teruggeboekt_op from actions
      where account_id = $1 and type = $2::action_type
        and teruggeboekt_op is not null
        and teruggeboekt_op > $3::timestamptz - interval '2 days'`,
    [invoer.accountId, invoer.type, invoer.nu.toISOString()],
  );
  const vandaag = eerder.filter((r) => {
    const op = r.teruggeboekt_op instanceof Date ? r.teruggeboekt_op : new Date(r.teruggeboekt_op);
    return lokaleDag(op, account.tijdzone) === dag;
  }).length;
  if (vandaag >= invoer.maxPerDagPerType) return false;

  const gemarkeerd = await db.query<{ id: string }>(
    `update actions set teruggeboekt_op = $2
      where id = $1 and teruggeboekt_op is null
      returning id`,
    [invoer.actieId, invoer.nu.toISOString()],
  );
  if (gemarkeerd.length === 0) return false;

  await db.query(
    `update usage set aantal = greatest(aantal - 1, 0)
      where account_id = $1 and type = $2::action_type and dag = $3::date`,
    [invoer.accountId, invoer.type, dag],
  );
  return true;
}
