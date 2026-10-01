import { randomBytes } from 'node:crypto';

import type { Klok } from '../budget/klok.ts';

/**
 * In-memory sessies voor de goedkeuringspagina (SPEC §12). Eén proces, één
 * gebruiker (Rubert); een database-tabel is onnodige complexiteit en zou
 * aanvalsoppervlak (session-fixation, SQL-injectie) toevoegen zonder
 * tegenprestatie. Herstart = alle sessies kwijt; dat is prima.
 *
 * Elke sessie heeft een eigen CSRF-token zodat formulieren niet via een
 * ander domein te triggeren zijn (SameSite=Strict is laag 1, de token is
 * laag 2).
 */

export interface Sessie {
  id: string;
  gebruiker: string;
  csrfToken: string;
  aangemaaktOp: Date;
  verlooptOp: Date;
}

export interface SessieStoreOpties {
  duurMs: number;
  klok: Klok;
}

export class SessieStore {
  private readonly map = new Map<string, Sessie>();
  private readonly duurMs: number;
  private readonly klok: Klok;

  constructor(opties: SessieStoreOpties) {
    this.duurMs = opties.duurMs;
    this.klok = opties.klok;
  }

  maak(gebruiker: string): Sessie {
    const nu = this.klok.nu();
    const sessie: Sessie = {
      id: randomBytes(32).toString('base64url'),
      gebruiker,
      csrfToken: randomBytes(24).toString('base64url'),
      aangemaaktOp: nu,
      verlooptOp: new Date(nu.getTime() + this.duurMs),
    };
    this.map.set(sessie.id, sessie);
    return sessie;
  }

  vind(id: string | undefined | null): Sessie | null {
    if (!id) return null;
    const sessie = this.map.get(id);
    if (!sessie) return null;
    if (this.klok.nu().getTime() >= sessie.verlooptOp.getTime()) {
      this.map.delete(id);
      return null;
    }
    return sessie;
  }

  verwijder(id: string | undefined | null): void {
    if (!id) return;
    this.map.delete(id);
  }

  aantal(): number {
    return this.map.size;
  }
}
