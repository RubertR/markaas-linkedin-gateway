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
