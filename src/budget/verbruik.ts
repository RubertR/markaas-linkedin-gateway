import type { Backend } from '../db/backend.ts';
import { vindAccount, type Account } from '../register/accounts.ts';

import { beoordeel, type Beoordeling, type BeoordelingsInvoer } from './beoordeel.ts';
import { telGebruikOpDag, telGebruikOverDagen, verhoogGebruik } from './gebruik.ts';
import type { Klok } from './klok.ts';
import type { ActieType, Limieten } from './limits.ts';
import { dagenInMaand, lokaleDag, lokaleDagen } from './tijdvenster.ts';

/**
 * Atomic reservering: binnen één transactie wordt de accountrij vergrendeld
 * (SELECT … FOR UPDATE), het huidige verbruik gelezen, de budgetcontrole
 * uitgevoerd en — bij `toegestaan` — de usage-teller met één verhoogd.
 * Zo kunnen twee acties die tegelijk aankomen samen nooit over de grens.
 */
export interface ReserveerInvoer {
  accountId: string;
  actieType: ActieType;
  goedgekeurd: boolean;
  klok: Klok;
  limieten: Limieten;
  minPauzeSeconden: number;
  laatsteActieOp?: Date | null;
  typeDagStop?: boolean;
  wekenSindsStart?: number;
  acceptatieVerhouding?: number;
}

export async function reserveerEnVerbruik(
  db: Backend,
  invoer: ReserveerInvoer,
): Promise<Beoordeling> {
  const nu = invoer.klok.nu();
  return db.transaction(async (tx) => {
    const account = await laadAccountVergrendeld(tx, invoer.accountId);
    if (!account) {
      throw new Error(`Account ${invoer.accountId} bestaat niet.`);
    }

    const vandaag = lokaleDag(nu, account.tijdzone);
    const gebruikDag = await telGebruikOpDag(tx, account.id, invoer.actieType, vandaag);

    const weekBereik = lokaleDagen(nu, account.tijdzone, 7);
    const gebruikWeek =
      invoer.actieType === 'inmail' || invoer.actieType === 'search'
        ? 0
        : await telGebruikOverDagen(tx, account.id, invoer.actieType, weekBereik);

    const gebruikMaand =
      invoer.actieType === 'inmail'
        ? await telGebruikOverDagen(
            tx,
            account.id,
            'inmail',
            dagenInMaand(nu, account.tijdzone),
          )
        : 0;

    const beoordelingsInvoer: BeoordelingsInvoer = {
      account: {
        status: account.status,
        abonnement: account.abonnement,
        opbouwFactor: account.opbouwFactor,
        afkoelingTot: account.afkoelingTot,
        tijdzone: account.tijdzone,
        openstaandeVerzoeken: account.openstaandeVerzoeken,
      },
      actieType: invoer.actieType,
      goedgekeurd: invoer.goedgekeurd,
      nu,
      gebruikDag,
      gebruikWeek,
      gebruikMaand,
      laatsteActieOp: invoer.laatsteActieOp ?? null,
      minPauzeSeconden: invoer.minPauzeSeconden,
      typeDagStop: invoer.typeDagStop ?? false,
      wekenSindsStart: invoer.wekenSindsStart ?? 0,
      acceptatieVerhouding: invoer.acceptatieVerhouding ?? 0,
      limieten: invoer.limieten,
    };

    const uitslag = beoordeel(beoordelingsInvoer);
    if (uitslag.status === 'toegestaan') {
      await verhoogGebruik(tx, account.id, invoer.actieType, vandaag, 1);
    }
    return uitslag;
  });
}

async function laadAccountVergrendeld(tx: Backend, accountId: string): Promise<Account | null> {
  // Vergrendel de accountrij voor de duur van de transactie zodat twee
  // gelijktijdige reserveringen hetzelfde budget zien.
  await tx.query(`select 1 from accounts where id = $1 for update`, [accountId]);
  return vindAccount(tx, accountId);
}
