/**
 * Pauze tussen opeenvolgende acties op hetzelfde account (SPEC §5 controle 5:
 * 2–8 minuten willekeurig). De pauze-kiezer is injecteerbaar zodat tests
 * deterministisch dezelfde pauze krijgen.
 */

export interface PauzeGrens {
  min: number;
  max: number;
}

export interface PauzeKiezer {
  /** Geeft de pauze in seconden voor de volgende actie op ditzelfde account. */
  kies(grensMinuten: PauzeGrens): number;
}

function schaalNaarSeconden(r: number, grens: PauzeGrens): number {
  const minSec = grens.min * 60;
  const maxSec = grens.max * 60;
  const begrensd = Math.max(0, Math.min(0.999999, r));
  return Math.round(minSec + begrensd * (maxSec - minSec));
}

/**
 * Mulberry32: klein, deterministisch, prima voor niet-cryptografische jitter.
 * Gebruikt in tests zodat herhaalbare runs mogelijk zijn.
 */
export function zaadRandom(zaad: number): PauzeKiezer {
  let state = zaad >>> 0;
  return {
    kies(grens: PauzeGrens): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return schaalNaarSeconden(r, grens);
    },
  };
}

export const systeemRandom: PauzeKiezer = {
  kies(grens: PauzeGrens): number {
    return schaalNaarSeconden(Math.random(), grens);
  },
};

export function vastePauze(seconden: number): PauzeKiezer {
  return {
    kies(): number {
      return seconden;
    },
  };
}
