import type { Klok } from '../budget/klok.ts';

/**
 * Brute-force-blokkade voor de goedkeuringspagina (SPEC §12). Vijf foute
 * pogingen op dezelfde sleutel → 15 minuten blokkade. Een geslaagde login
 * reset de teller.
 *
 * In-memory per proces; één server, één gebruiker. Herstart = reset — dat is
 * acceptabel want een aanvaller moet dan ook opnieuw beginnen.
 */

export interface PogingenOpties {
  maxFouten: number;
  blokkadeMs: number;
  klok: Klok;
}

interface Poging {
  fouten: number;
  blokkadeTot: Date | null;
}

export class PogingenTracker {
  private readonly map = new Map<string, Poging>();
  private readonly maxFouten: number;
  private readonly blokkadeMs: number;
  private readonly klok: Klok;

  constructor(opties: PogingenOpties) {
    this.maxFouten = opties.maxFouten;
    this.blokkadeMs = opties.blokkadeMs;
    this.klok = opties.klok;
  }

  isGeblokkeerd(sleutel: string): boolean {
    const p = this.map.get(sleutel);
    if (!p || !p.blokkadeTot) return false;
    if (this.klok.nu().getTime() >= p.blokkadeTot.getTime()) {
      // Blokkade voorbij: schoonvegen.
      this.map.delete(sleutel);
      return false;
    }
    return true;
  }

  resterendSeconden(sleutel: string): number {
    const p = this.map.get(sleutel);
    if (!p?.blokkadeTot) return 0;
    const resterend = p.blokkadeTot.getTime() - this.klok.nu().getTime();
    return resterend > 0 ? Math.ceil(resterend / 1000) : 0;
  }

  registreerFout(sleutel: string): void {
    if (this.isGeblokkeerd(sleutel)) return;
    const bestaand = this.map.get(sleutel);
    const fouten = (bestaand?.fouten ?? 0) + 1;
    const blokkadeTot =
      fouten >= this.maxFouten ? new Date(this.klok.nu().getTime() + this.blokkadeMs) : null;
    this.map.set(sleutel, { fouten, blokkadeTot });
  }

  reset(sleutel: string): void {
    this.map.delete(sleutel);
  }
}
