import { createHash } from 'node:crypto';

import type { Backend } from '../db/backend.ts';
import { vindAccount, werkAccountStatusBij, type Account } from '../register/accounts.ts';
import type { UnipileClient } from '../unipile/client.ts';
import {
  UnipileAccountCredentialsFout,
  UnipileFout,
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
} from '../unipile/errors.ts';

import { inAfkoeling, startAfkoeling } from './afkoeling.ts';
import type { Klok } from './klok.ts';
import type { Limieten } from './limits.ts';
import { binnenWerkuren, isWerkdag, lokaleDag } from './tijdvenster.ts';

/**
 * Dagelijkse sync van `accounts.openstaande_verzoeken` met Unipile (SPEC §5a).
 *
 * De gateway telt zelf op (invite `done`/`onzeker`) en af (acceptatie), maar
 * mist verlopen of ingetrokken invites en invites die buiten de gateway om in
 * LinkedIn zijn verstuurd. Eén keer per werkdag per account zet deze sync de
 * teller gelijk aan het aantal openstaande invites volgens
 * `GET /api/v1/users/invite/sent`: die lijst bevat alleen nog openstaande
 * invites.
 *
 * - Alleen accounts met status `OK`/`RECONNECTED`, buiten afkoeling, op een
 *   werkdag binnen het tijdvenster in de tijdzone van het account.
 * - Moment: per account en dag een vast, willekeurig ogend moment binnen het
 *   venster (SPEC §8: geen polling op vaste tijden).
 * - Eén poging per dag: een gateway-event `verzoeken_sync:<account>:<dag>`
 *   wordt vóór de GET geclaimd. Ook na 429, time-out of fout volgt er pas de
 *   volgende werkdag een nieuwe poging; de teller blijft dan staan.
 * - 429 → account in afkoeling (SPEC §5 controle 6), net als bij acties.
 */

export interface SyncMomentKiezer {
  /** Minuten na de start van het tijdvenster waarop de sync van deze dag mag. */
  minutenNaStart(accountId: string, dag: string, vensterMinuten: number): number;
}

/** Ruimte aan het eind van het venster, zodat een tick (elke 2–8 min) het moment nog haalt. */
const MARGE_EINDE_MINUTEN = 30;

/**
 * Vast per account en dag (zelfde uitkomst bij elke tick), verschillend per
 * dag en per account. Geen opgeslagen toestand nodig.
 */
export const spreidingPerDag: SyncMomentKiezer = {
  minutenNaStart(accountId, dag, vensterMinuten) {
    const ruimte = Math.max(1, vensterMinuten - MARGE_EINDE_MINUTEN);
    const hash = createHash('sha256').update(`${accountId}:${dag}`).digest();
    return hash.readUInt32BE(0) % ruimte;
  },
};

export interface VerzoekenSyncDeps {
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  klok: Klok;
  moment?: SyncMomentKiezer;
}

export type SyncResultaat =
  | 'gelijkgezet'
  | 'zou_gelijkzetten'
  | 'overgeslagen'
  | 'afkoeling'
  | 'time-out'
  | 'fout';

export interface AccountSyncUitkomst {
  accountId: string;
  resultaat: SyncResultaat;
  /** Teller vóór de sync. */
  voor: number;
  /** Aantal openstaande invites volgens Unipile (ondergrens als `volledig` false is). */
  werkelijk?: number;
  volledig?: boolean;
  reden: string;
}

export interface VerzoekenSyncUitkomst {
  resultaten: AccountSyncUitkomst[];
  /** Unipile weigert onze API-sleutel: planner moet stoppen. */
  gatewayGestopt: boolean;
}

/**
 * Eén ronde voor de planner-lus: synct elk account dat vandaag aan de beurt
 * is en nog niet gesynct is. Accounts die niet aan de beurt zijn, komen niet
 * in de resultaten.
 */
export async function verwerkVerzoekenSyncTick(
  deps: VerzoekenSyncDeps,
): Promise<VerzoekenSyncUitkomst> {
  return await loop(deps, { uitvoeren: true, wachtOpMoment: true, metOvergeslagen: false });
}

/**
 * Eenmalig gelijkzetten (`npm run verzoeken:sync`). Wacht niet op het moment
 * van de dag, maar blijft binnen werkdag en tijdvenster. Zonder `uitvoeren`
 * wordt er niets geschreven (ook geen afkoeling of status), alleen gelezen.
 */
export async function syncVerzoekenNu(
  deps: VerzoekenSyncDeps,
  opties: { uitvoeren: boolean },
): Promise<VerzoekenSyncUitkomst> {
  return await loop(deps, {
    uitvoeren: opties.uitvoeren,
    wachtOpMoment: false,
    metOvergeslagen: true,
  });
}

interface LoopOpties {
  uitvoeren: boolean;
  wachtOpMoment: boolean;
  metOvergeslagen: boolean;
}

async function loop(deps: VerzoekenSyncDeps, opties: LoopOpties): Promise<VerzoekenSyncUitkomst> {
  const rijen = await deps.db.query<{ id: string }>(
    `select id from accounts where unipile_account_id is not null order by aangemaakt_op, id`,
  );
  const resultaten: AccountSyncUitkomst[] = [];
  for (const { id } of rijen) {
    const account = await vindAccount(deps.db, id);
    if (!account) continue;
    const uitkomst = await syncAccount(deps, account, opties);
    if (uitkomst === 'gateway_gestopt') {
      return { resultaten, gatewayGestopt: true };
    }
    if (uitkomst.resultaat === 'overgeslagen' && !opties.metOvergeslagen) continue;
    resultaten.push(uitkomst);
  }
  return { resultaten, gatewayGestopt: false };
}

async function syncAccount(
  deps: VerzoekenSyncDeps,
  account: Account,
  opties: LoopOpties,
): Promise<AccountSyncUitkomst | 'gateway_gestopt'> {
  const nu = deps.klok.nu();
  const dag = lokaleDag(nu, account.tijdzone);
  const voor = account.openstaandeVerzoeken;
  const basis = { accountId: account.id, voor };

  const nietNu = nietAanDeBeurt(deps, account, nu, dag, opties.wachtOpMoment);
  if (nietNu) return { ...basis, resultaat: 'overgeslagen', reden: nietNu };

  const externId = `verzoeken_sync:${account.id}:${dag}`;
  if (opties.uitvoeren && !(await claimDag(deps.db, account.id, externId, dag))) {
    return { ...basis, resultaat: 'overgeslagen', reden: 'Vandaag al gesynct.' };
  }

  const uitkomst = await haalEnZetGelijk(deps, account, opties.uitvoeren);
  if (uitkomst === 'gateway_gestopt') {
    if (opties.uitvoeren) {
      await legVast(deps.db, externId, { dag, resultaat: 'fout', reden: 'gateway-sleutel geweigerd' });
    }
    return uitkomst;
  }
  const volledig: AccountSyncUitkomst = { ...basis, ...uitkomst };
  if (opties.uitvoeren) {
    await legVast(deps.db, externId, {
      dag,
      resultaat: volledig.resultaat,
      voor,
      ...(volledig.werkelijk !== undefined ? { werkelijk: volledig.werkelijk } : {}),
      ...(volledig.volledig !== undefined ? { volledig: volledig.volledig } : {}),
      reden: volledig.reden,
    });
  }
  return volledig;
}

function nietAanDeBeurt(
  deps: VerzoekenSyncDeps,
  account: Account,
  nu: Date,
  dag: string,
  wachtOpMoment: boolean,
): string | null {
  if (account.status !== 'OK' && account.status !== 'RECONNECTED') {
    return `Account heeft status ${account.status}; sync wacht tot de sessie weer werkt.`;
  }
  if (inAfkoeling(account, nu)) {
    return 'Account is in afkoeling; geen LinkedIn-verkeer tot de afkoeling voorbij is.';
  }
  const tv = deps.limieten.tijdvenster;
  if (!isWerkdag(nu, account.tijdzone, tv.werkdagen)) {
    return 'Geen werkdag in de tijdzone van het account; sync volgt op de eerstvolgende werkdag.';
  }
  if (!binnenWerkuren(nu, account.tijdzone, tv.start_lokaal, tv.einde_lokaal)) {
    return `Buiten het tijdvenster ${tv.start_lokaal}–${tv.einde_lokaal} (${account.tijdzone}); probeer het binnen werktijd opnieuw.`;
  }
  if (wachtOpMoment) {
    const kiezer = deps.moment ?? spreidingPerDag;
    const venster = minuten(tv.einde_lokaal) - minuten(tv.start_lokaal);
    const moment = minuten(tv.start_lokaal) + kiezer.minutenNaStart(account.id, dag, venster);
    if (lokaleMinuten(nu, account.tijdzone) < moment) {
      return 'Moment van de sync voor vandaag is nog niet aangebroken.';
    }
  }
  return null;
}

type Gemeten = Pick<AccountSyncUitkomst, 'resultaat' | 'werkelijk' | 'volledig' | 'reden'>;

async function haalEnZetGelijk(
  deps: VerzoekenSyncDeps,
  account: Account,
  uitvoeren: boolean,
): Promise<Gemeten | 'gateway_gestopt'> {
  const uid = account.unipileAccountId;
  if (!uid) return { resultaat: 'overgeslagen', reden: 'Account is nog niet gekoppeld.' };
  try {
    const telling = await deps.unipile.telVerstuurdeInvites({
      accountId: uid,
      paginaGrootte: deps.limieten.verzoeken_sync.pagina_grootte,
      maxPaginas: deps.limieten.verzoeken_sync.max_paginas,
    });
    const aantalTekst = telling.volledig ? String(telling.aantal) : `minstens ${telling.aantal}`;
    if (uitvoeren) {
      await deps.db.query(
        `update accounts set openstaande_verzoeken = $2 where id = $1`,
        [account.id, telling.aantal],
      );
    }
    return {
      resultaat: uitvoeren ? 'gelijkgezet' : 'zou_gelijkzetten',
      werkelijk: telling.aantal,
      volledig: telling.volledig,
      reden: `Unipile meldt ${aantalTekst} openstaande invites; teller ${uitvoeren ? 'gezet' : 'zou gaan'} van ${account.openstaandeVerzoeken} naar ${telling.aantal}.`,
    };
  } catch (err) {
    if (err instanceof UnipileGatewayAuthFout) return 'gateway_gestopt';
    if (err instanceof UnipileTijdelijkeFout && err.status === 429) {
      if (uitvoeren) {
        await startAfkoeling(deps.db, account.id, deps.klok.nu(), deps.limieten.afkoeling);
      }
      return {
        resultaat: 'afkoeling',
        reden: uitvoeren
          ? 'LinkedIn vroeg om pauze (HTTP 429); account 48 uur in afkoeling, teller ongewijzigd.'
          : 'LinkedIn vroeg om pauze (HTTP 429); de dry-run heeft géén afkoeling gestart. Draai vandaag niet opnieuw en controleer het account in LinkedIn.',
      };
    }
    if (err instanceof UnipileTimeoutFout) {
      return {
        resultaat: 'time-out',
        reden: `${err.message} Teller ongewijzigd; volgende poging op de eerstvolgende werkdag.`,
      };
    }
    if (err instanceof UnipileAccountCredentialsFout) {
      if (uitvoeren) await werkAccountStatusBij(deps.db, account.id, 'CREDENTIALS');
      return {
        resultaat: 'fout',
        reden: 'LinkedIn-sessie van dit account is verlopen; account op CREDENTIALS, teller ongewijzigd. Opnieuw koppelen.',
      };
    }
    const bericht = err instanceof UnipileFout ? err.message : `Onverwachte fout: ${String((err as Error)?.message ?? err)}`;
    return {
      resultaat: 'fout',
      reden: `${bericht} Teller ongewijzigd; volgende poging op de eerstvolgende werkdag.`,
    };
  }
}

async function claimDag(db: Backend, accountId: string, externId: string, dag: string): Promise<boolean> {
  const rijen = await db.query<{ id: string }>(
    `insert into events(bron, type, extern_id, account_id, payload)
     values ('gateway', 'verzoeken_sync', $1, $2, $3::jsonb)
     on conflict (bron, extern_id) where extern_id is not null do nothing
     returning id`,
    [externId, accountId, JSON.stringify({ dag, resultaat: 'bezig' })],
  );
  return rijen.length > 0;
}

async function legVast(db: Backend, externId: string, payload: Record<string, unknown>): Promise<void> {
  await db.query(
    `update events set payload = $2::jsonb where bron = 'gateway' and extern_id = $1`,
    [externId, JSON.stringify(payload)],
  );
}

function minuten(uuMm: string): number {
  const [u, m] = uuMm.split(':').map(Number) as [number, number];
  return u * 60 + m;
}

function lokaleMinuten(datum: Date, tijdzone: string): number {
  const delen = new Intl.DateTimeFormat('en-GB', {
    timeZone: tijdzone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(datum);
  const uur = Number(delen.find((d) => d.type === 'hour')?.value ?? '0') % 24;
  const minuut = Number(delen.find((d) => d.type === 'minute')?.value ?? '0');
  return uur * 60 + minuut;
}
