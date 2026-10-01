import type { WerkdagenBereik } from '../budget/limits.ts';
import { lokaleDag } from '../budget/tijdvenster.ts';

/**
 * Willekeurige keuze binnen een werkdagen-bereik (SPEC §8a.1). Injecteerbaar
 * zodat tests een vaste waarde kunnen afdwingen; productie gebruikt
 * `systeemWerkdagenKiezer`.
 */
export interface WerkdagenKiezer {
  kies(bereik: WerkdagenBereik): number;
}

export function vasteWerkdagen(aantal: number): WerkdagenKiezer {
  return { kies: () => aantal };
}

export const systeemWerkdagenKiezer: WerkdagenKiezer = {
  kies(bereik) {
    const r = Math.random();
    const begrensd = Math.max(0, Math.min(0.999999, r));
    const breedte = bereik.max - bereik.min + 1;
    return bereik.min + Math.floor(begrensd * breedte);
  },
};

/**
 * Telt `werkdagen` werkdagen door vanaf `vanaf` in de opgegeven tijdzone.
 * De klok begint op het volgende moment na `vanaf`; is `vanaf` zelf een
 * werkdag, dan telt die niet mee (we zoeken toekomstige dagen).
 *
 * Werkdagen = Ma t/m Vr (vast; we gebruiken bewust NIET
 * `tijdvenster.werkdagen` omdat die aanpasbaar is voor budgetvensters en
 * sequenties horen gewoon op werkdagen uit te komen).
 */
export function teltDoorWerkdagen(vanaf: Date, werkdagen: number, tijdzone: string): Date {
  if (!Number.isInteger(werkdagen) || werkdagen < 0) {
    throw new Error('werkdagen moet een niet-negatief geheel getal zijn.');
  }
  if (werkdagen === 0) return new Date(vanaf.getTime());

  let doel = new Date(vanaf.getTime());
  let geteld = 0;
  // Stapjes van 24 uur zijn genoeg: we willen de "dag" vinden; het exacte
  // moment is onbelangrijk zolang de tick het nog ziet als "volgende_actie_op".
  const DAG_MS = 24 * 60 * 60 * 1000;
  // Veilige bovengrens: nooit meer dan 60 iteraties nodig voor 21 werkdagen.
  for (let i = 0; i < 120 && geteld < werkdagen; i++) {
    doel = new Date(doel.getTime() + DAG_MS);
    if (isLokaalWerkdag(doel, tijdzone)) geteld++;
  }
  return doel;
}

function isLokaalWerkdag(datum: Date, tijdzone: string): boolean {
  // Weekdag-nummer via lokaleDag + weekday: hergebruik Intl voor correcte
  // weekend-detectie in de doel-tijdzone.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tijdzone,
    weekday: 'short',
  });
  const weekdag = fmt.format(datum);
  return weekdag !== 'Sat' && weekdag !== 'Sun';
}

/**
 * Export voor tests die willen controleren dat we niet per ongeluk op
 * zaterdag of zondag landen.
 */
export function lokaleWeekdagKort(datum: Date, tijdzone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tijdzone, weekday: 'short' }).format(datum);
}

export { lokaleDag };
