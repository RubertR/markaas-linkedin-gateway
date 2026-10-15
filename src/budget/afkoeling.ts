import type { Backend } from '../db/backend.ts';

import type { Afkoeling } from './limits.ts';

/**
 * Zet een account in afkoeling (SPEC §5 controle 6, docs/limieten.md).
 * Trigger: HTTP 429, captcha of waarschuwing van LinkedIn/Unipile.
 * - `afkoeling_tot = nu + duur_uren` (48 uur in de huidige configuratie).
 * - `opbouw_factor = opbouw_factor_na` (0.5) — de opbouw begint na afkoeling
 *   opnieuw.
 */
export async function startAfkoeling(
  db: Backend,
  accountId: string,
  nu: Date,
  afkoeling: Afkoeling,
): Promise<void> {
  const tot = new Date(nu.getTime() + afkoeling.duur_uren * 3600_000);
  await db.query(
    `update accounts
     set afkoeling_tot = $2,
         opbouw_factor = $3
     where id = $1`,
    [accountId, tot.toISOString(), afkoeling.opbouw_factor_na],
  );
}

/**
 * Start alleen de opbouwperiode van na een afkoeling, zonder pauze ervoor.
 * Gebruikt bij het vrijgeven van een account dat op `STOPPED` stond
 * (SPEC §6b punt 3): opbouw_factor naar `opbouw_factor_na` voor
 * `opbouw_periode_dagen`.
 *
 * Hetzelfde mechanisme als na een afkoeling: de opbouwperiode hangt aan
 * `afkoeling_tot` (zie `mogelijkeOpbouwNaAfkoeling`). Daarom zetten we
 * `afkoeling_tot` op nu — de afkoeling is dus direct voorbij (`inAfkoeling`
 * is strikt), maar de verlaagde opbouw geldt de volgende dagen. Een lopende
 * afkoeling die verder in de toekomst ligt, blijft staan.
 */
export async function startOpbouwPeriode(
  db: Backend,
  accountId: string,
  nu: Date,
  afkoeling: Afkoeling,
): Promise<void> {
  await db.query(
    `update accounts
     set afkoeling_tot = greatest(coalesce(afkoeling_tot, $2::timestamptz), $2::timestamptz),
         opbouw_factor = $3
     where id = $1`,
    [accountId, nu.toISOString(), afkoeling.opbouw_factor_na],
  );
}

export interface AfkoelingState {
  afkoelingTot: Date | null;
}

export function inAfkoeling(state: AfkoelingState, nu: Date): boolean {
  if (!state.afkoelingTot) return false;
  return nu.getTime() < state.afkoelingTot.getTime();
}

/**
 * Geeft terug of de wekelijkse opbouw-stap mag plaatsvinden. Na afkoeling
 * blijft opbouw_factor `opbouw_periode_dagen` lang op het verlaagde niveau.
 */
export function mogelijkeOpbouwNaAfkoeling(
  state: AfkoelingState,
  nu: Date,
  afkoeling: Afkoeling,
): boolean {
  if (!state.afkoelingTot) return true;
  const grens = state.afkoelingTot.getTime() + afkoeling.opbouw_periode_dagen * 86_400_000;
  return nu.getTime() >= grens;
}
