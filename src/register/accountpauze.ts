import type { Backend } from '../db/backend.ts';
import { startOpbouwPeriode } from '../budget/afkoeling.ts';
import type { Afkoeling } from '../budget/limits.ts';

import type { AccountStatus } from './status.ts';

/**
 * Account op pauze (SPEC §6b). Een account op `CREDENTIALS`, `ERROR` of
 * `STOPPED` verstuurt niets, maar goedgekeurde acties blijven bewaard:
 *
 * 1. Budgetcontrole 1 geeft `wachtrij` (src/budget/beoordeel.ts); de planner
 *    parkeert de actie 60 minuten en laat hem na
 *    `account_pauze.max_parkeer_dagen` vervallen (src/queue/planner.ts).
 *    Synchrone `search`/`profile` worden direct geweigerd (src/mcp/synchroon.ts).
 * 2. Opnieuw koppelen (callback `RECONNECTED` of een herstel-webhook) heft
 *    `CREDENTIALS` en `ERROR` op, maar geen `STOPPED` die de gateway zette
 *    (`herstelHeftStatusOp`).
 * 3. Rubert geeft een account op `ERROR` of `STOPPED` vrij in de admin
 *    (`geefAccountVrij`).
 *
 * `PERMISSIONS` en een onbekende status vallen hier bewust buiten (§6b punt 1).
 */

const PAUZE_STATUSSEN: ReadonlySet<AccountStatus> = new Set(['CREDENTIALS', 'ERROR', 'STOPPED']);

export function isAccountPauze(status: AccountStatus): boolean {
  return PAUZE_STATUSSEN.has(status);
}

/** Vaste reden waarmee een te lang geparkeerde actie vervalt (SPEC §6b punt 1). */
export const REDEN_TE_LANG_OP_PAUZE = 'account stond te lang op pauze';

/** Reden van het event als opnieuw koppelen een gateway-STOPPED niet opheft (§6b punt 2). */
export const REDEN_GESTOPT_NA_KOPPELEN = 'opnieuw gekoppeld, maar nog gestopt door beperking';

/** Korte NL-uitleg per pauzestatus, voor redenen richting skill en goedkeuringspagina. */
export function pauzeUitleg(status: AccountStatus): string {
  switch (status) {
    case 'CREDENTIALS':
      return 'de LinkedIn-sessie is verlopen; het account moet opnieuw gekoppeld worden';
    case 'ERROR':
      return 'het account staat op fout (ERROR); Rubert zoekt de oorzaak uit';
    case 'STOPPED':
      return 'het account is gestopt (bijv. beperkt door LinkedIn); Rubert moet het eerst vrijgeven';
    default:
      return `het account staat op ${status}`;
  }
}

/**
 * Mag een herstelsignaal (callback `RECONNECTED`, webhook `ok`/`reconnected`)
 * de huidige status opheffen? (SPEC §6b punt 2.)
 *
 * - `CREDENTIALS` en `ERROR`: ja. Een `ERROR` van de gateway komt alleen uit
 *   een onbekende 401/403 (§6a); opnieuw inloggen kan die oplossen.
 * - `STOPPED`: alleen als Unipile hem zelf meldde. Een `STOPPED` van de
 *   gateway (`account_restricted`) blijft staan tot Rubert hem vrijgeeft.
 */
export function herstelHeftStatusOp(huidig: AccountStatus, huidigDoorGateway: boolean): boolean {
  if (huidig === 'STOPPED') return !huidigDoorGateway;
  return true;
}

/**
 * Legt vast dat het account opnieuw gekoppeld is (sessie geldig), maar door
 * de gateway gestopt blijft: gateway-event `account_status` met status
 * `STOPPED` en de vaste reden.
 */
export async function meldGestoptNaKoppelen(
  db: Backend,
  accountId: string,
  signaal: string,
  nu: Date,
): Promise<void> {
  const payload = {
    status: 'STOPPED',
    vorige_status: 'STOPPED',
    reden: REDEN_GESTOPT_NA_KOPPELEN,
    signaal,
    op: nu.toISOString(),
  };
  await db.query(
    `insert into events(bron, type, extern_id, account_id, payload)
     values ('gateway', 'account_status', $1, $2, $3::text::jsonb)
     on conflict (bron, extern_id) where extern_id is not null do nothing`,
    [`account_status:${accountId}:STOPPED:gekoppeld:${signaal}:${nu.toISOString()}`, accountId, JSON.stringify(payload)],
  );
}

export class AccountVrijgaveFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'AccountVrijgaveFout';
  }
}

export interface VrijgaveInvoer {
  accountId: string;
  reden: string;
  /** Wie het deed; in v1 altijd `rubert`. */
  door: string;
  nu: Date;
  afkoeling: Afkoeling;
}

export interface VrijgaveUitkomst {
  vorigeStatus: AccountStatus;
  opbouwVerlaagd: boolean;
}

const MAX_REDEN_TEKENS = 500;

/**
 * Geeft een account op `ERROR` of `STOPPED` vrij (SPEC §6b punt 3): status
 * `OK`, en bij `STOPPED` de opbouwperiode van na een afkoeling
 * (`startOpbouwPeriode`). Een `CREDENTIALS`-account wordt niet vrijgegeven:
 * dat lost zich op door opnieuw te koppelen. Status, opbouw en het
 * gateway-event `account_status` (met reden en wie) gaan in één transactie.
 */
export async function geefAccountVrij(db: Backend, invoer: VrijgaveInvoer): Promise<VrijgaveUitkomst> {
  const reden = invoer.reden.trim();
  if (!reden) {
    throw new AccountVrijgaveFout(
      'Vul een reden in voor het vrijgeven, bijvoorbeeld "eigenaar heeft in LinkedIn gecontroleerd, beperking opgeheven". Het account is niet vrijgegeven.',
    );
  }
  if (reden.length > MAX_REDEN_TEKENS) {
    throw new AccountVrijgaveFout(
      `De reden is te lang (${reden.length} tekens, hoogstens ${MAX_REDEN_TEKENS}). Maak hem korter; het account is niet vrijgegeven.`,
    );
  }
  return await db.transaction(async (tx) => {
    const rijen = await tx.query<{ status: AccountStatus }>(
      `select status from accounts where id = $1 for update`,
      [invoer.accountId],
    );
    const huidig = rijen[0]?.status;
    if (!huidig) {
      throw new AccountVrijgaveFout('Onbekend account; er is niets vrijgegeven.');
    }
    if (huidig === 'CREDENTIALS') {
      throw new AccountVrijgaveFout(
        'Dit account wacht op opnieuw inloggen (CREDENTIALS). Vrijgeven helpt dan niet: stuur de eigenaar een reconnect-link.',
      );
    }
    if (huidig !== 'ERROR' && huidig !== 'STOPPED') {
      throw new AccountVrijgaveFout(
        `Dit account staat op ${huidig}, niet op ERROR of STOPPED; er is niets vrijgegeven.`,
      );
    }
    await tx.query(
      `update accounts set status = 'OK'::account_status, status_sinds = now() where id = $1`,
      [invoer.accountId],
    );
    const opbouwVerlaagd = huidig === 'STOPPED';
    if (opbouwVerlaagd) {
      await startOpbouwPeriode(tx, invoer.accountId, invoer.nu, invoer.afkoeling);
    }
    const payload = {
      status: 'OK',
      vorige_status: huidig,
      reden: `Vrijgegeven door ${invoer.door}: ${reden}`,
      vrijgave: true,
      door: invoer.door,
      ...(opbouwVerlaagd
        ? {
            opbouw_factor: invoer.afkoeling.opbouw_factor_na,
            opbouw_periode_dagen: invoer.afkoeling.opbouw_periode_dagen,
          }
        : {}),
      op: invoer.nu.toISOString(),
    };
    await tx.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('gateway', 'account_status', $1, $2, $3::text::jsonb)
       on conflict (bron, extern_id) where extern_id is not null do nothing`,
      [`account_status:${invoer.accountId}:OK:vrijgave:${invoer.nu.toISOString()}`, invoer.accountId, JSON.stringify(payload)],
    );
    return { vorigeStatus: huidig, opbouwVerlaagd };
  });
}
