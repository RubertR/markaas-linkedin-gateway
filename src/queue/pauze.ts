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
  /**
   * Variant met de grenzen al in seconden (SPEC §7, MCP-sync-tools gebruiken
   * dit voor de per-type pauzes uit `pauze_mcp_sync_seconden`).
   */
  kiesSeconden(grensSeconden: PauzeGrens): number;
}

function schaal(r: number, minSec: number, maxSec: number): number {
  const begrensd = Math.max(0, Math.min(0.999999, r));
  return Math.round(minSec + begrensd * (maxSec - minSec));
}

function schaalNaarSeconden(r: number, grens: PauzeGrens): number {
  return schaal(r, grens.min * 60, grens.max * 60);
}

function schaalSeconden(r: number, grens: PauzeGrens): number {
  return schaal(r, grens.min, grens.max);
}

/**
 * Mulberry32: klein, deterministisch, prima voor niet-cryptografische jitter.
 * Gebruikt in tests zodat herhaalbare runs mogelijk zijn.
 */
export function zaadRandom(zaad: number): PauzeKiezer {
  let state = zaad >>> 0;
  function trek(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    kies(grens: PauzeGrens): number {
      return schaalNaarSeconden(trek(), grens);
    },
    kiesSeconden(grens: PauzeGrens): number {
      return schaalSeconden(trek(), grens);
    },
  };
}

export const systeemRandom: PauzeKiezer = {
  kies(grens: PauzeGrens): number {
    return schaalNaarSeconden(Math.random(), grens);
  },
  kiesSeconden(grens: PauzeGrens): number {
    return schaalSeconden(Math.random(), grens);
  },
};

export function vastePauze(seconden: number): PauzeKiezer {
  return {
    kies(): number {
      return seconden;
    },
    kiesSeconden(): number {
      return seconden;
    },
  };
}
