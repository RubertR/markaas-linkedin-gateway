import type { InviteLimiet, Opbouw, UnipileSignaal } from './limits.ts';

/**
 * Berekening van opbouw_factor. SPEC §5: nieuw of stil account start op 0.5;
 * elke week +0.2 zolang acceptatie van verzoeken ≥ 30%; maximum 1.0.
 * Deze functie neemt één weekstap: gegeven de huidige factor en acceptatie
 * geeft hij de factor voor de volgende week terug.
 */
export interface NieuweFactorInvoer {
  huidigeFactor: number;
  acceptatieVerhouding: number;
  opbouw: Opbouw;
}

export function nieuweOpbouwFactor(invoer: NieuweFactorInvoer): number {
  const { huidigeFactor, acceptatieVerhouding, opbouw } = invoer;
  if (acceptatieVerhouding < opbouw.acceptatie_drempel) return huidigeFactor;
  const kandidaat = huidigeFactor + opbouw.stap_per_week;
  return Math.min(opbouw.maximum, afronden(kandidaat));
}

/**
 * Unipile-antwoord bevat soms `usage` (percentage van LinkedIns limiet,
 * bij 50/75/90/95%). Bij ≥ drempel direct opbouw_factor omlaag naar
 * `nieuwe_factor_bij_afremmen`. Geeft `null` als er geen verlaging nodig is.
 */
export interface VerlagingInvoer {
  huidigeFactor: number;
  usagePercentage: number;
  signaal: UnipileSignaal;
}

export function verlagingNaUnipileSignaal(invoer: VerlagingInvoer): number | null {
  const { huidigeFactor, usagePercentage, signaal } = invoer;
  if (usagePercentage < signaal.afremmen_bij_percentage) return null;
  if (huidigeFactor <= signaal.nieuwe_factor_bij_afremmen) return null;
  return signaal.nieuwe_factor_bij_afremmen;
}

/**
 * Weekbudget voor invites, met eventuele bonus na ≥ `min_weken_opbouw`
 * met acceptatie ≥ drempel (SPEC §5 bonus-regel, salesnav).
 * Resultaat is al vermenigvuldigd met opbouw_factor (afgerond naar beneden).
 */
export interface WeekBudgetInvoer {
  invite: InviteLimiet;
  opbouwFactor: number;
  wekenSindsStart: number;
  acceptatieVerhouding: number;
}

export function weekBudgetMetBonus(invoer: WeekBudgetInvoer): number {
  const { invite, opbouwFactor, wekenSindsStart, acceptatieVerhouding } = invoer;
  const basis = invite.week;
  const bonus = invite.bonus_na_opbouw;
  const toepasbareNorm =
    bonus &&
    wekenSindsStart >= bonus.min_weken_opbouw &&
    acceptatieVerhouding >= bonus.acceptatie_drempel
      ? bonus.week_maximum
      : basis;
  return geschaaldeNorm(toepasbareNorm, opbouwFactor);
}

/**
 * Gewone dag-/weekbudget-berekening × opbouw_factor, afgerond naar beneden
 * zodat we onder de werknorm blijven. Ondergrens 1 als de ongeschaalde norm
 * ≥ 1 is: anders wordt een norm van 1 (zoals search.runs_per_dag) tijdens de
 * opbouw 0 en is het actietype volledig geblokkeerd. Afkoeling staat hier
 * los van (eigen controle in beoordeel.ts); factor 0 blijft 0.
 */
export function geschaaldeNorm(norm: number, opbouwFactor: number): number {
  const geschaald = Math.floor(norm * opbouwFactor);
  if (norm >= 1 && opbouwFactor > 0) return Math.max(1, geschaald);
  return geschaald;
}

function afronden(waarde: number): number {
  return Math.round(waarde * 100) / 100;
}
