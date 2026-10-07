import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import {
  goedkeur,
  goedkeurBatch,
  goedkeurderKlant,
  lijstDrafts,
  wijsAf,
  type DraftWeergave,
  type GoedkeurBatchResultaat,
} from '../admin/dienst.ts';
import type { Actie } from '../queue/acties.ts';
import { maakReconnectLink, type KoppelflowOpties } from '../register/koppelflow.ts';
import { maakNieuweKoppeluitnodiging } from '../register/nieuweklant.ts';
import type { UitnodigingOpties } from '../register/uitnodiging.ts';
import type { UnipileClient } from '../unipile/client.ts';

import { isUuid } from './gebruikers.ts';
import { accountsVanKlant, bepaalStand, kanOpnieuwKoppelen } from './resultaten.ts';

/**
 * Dienstlaag van het klantportaal (SPEC §14.3). Elke functie krijgt de klant
 * van de ingelogde gebruiker mee en controleert eerst dat de actie of het
 * account bij die klant hoort (SPEC §14.1). Zo niet: `PortaalNietGevondenFout`
 * (de server maakt er een 404 van) en er verandert niets.
 *
 * Goedkeuren en afwijzen lopen via dezelfde helpers als de admin
 * (`admin/dienst.ts` → `queue/acties.ts`), met `door = klant:<e-mail>`, zodat
 * budget, tijdvenster en sequentieregels identiek gelden: de planner pakt
 * goedgekeurde acties op dezelfde manier op.
 */

export class PortaalNietGevondenFout extends Error {
  constructor(bericht = 'Dit concept bestaat niet (meer) of hoort niet bij uw organisatie; er is niets gewijzigd.') {
    super(bericht);
    this.name = 'PortaalNietGevondenFout';
  }
}

export interface PortaalGebruikerContext {
  clientId: string;
  email: string;
}

export async function conceptenVoorKlant(
  db: Backend,
  clientId: string,
  opties: { limieten: Limieten; klok: Klok },
): Promise<DraftWeergave[]> {
  return await lijstDrafts(db, { ...opties, clientId });
}

/** Ids die bij de klant horen én nog als concept open staan. */
async function openConceptenVanKlant(
  db: Backend,
  clientId: string,
  actieIds: readonly string[],
): Promise<Set<string>> {
  const geldig = actieIds.filter(isUuid);
  if (geldig.length === 0) return new Set();
  const rijen = await db.query<{ id: string }>(
    `select a.id from actions a
     join accounts acc on acc.id = a.account_id
     where a.id = any($1::uuid[])
       and acc.client_id = $2
       and a.status = 'draft'::action_status
       and a.type in ('invite', 'message', 'inmail')`,
    [geldig, clientId],
  );
  return new Set(rijen.map((r) => r.id));
}

async function eisConcept(db: Backend, clientId: string, actieId: string): Promise<void> {
  const gevonden = await openConceptenVanKlant(db, clientId, [actieId]);
  if (!gevonden.has(actieId)) throw new PortaalNietGevondenFout();
}

export async function keurGoedVoorKlant(
  db: Backend,
  gebruiker: PortaalGebruikerContext,
  actieId: string,
  opties: { limieten: Limieten; klok: Klok },
): Promise<Actie> {
  await eisConcept(db, gebruiker.clientId, actieId);
  return await goedkeur(db, actieId, {
    klok: opties.klok,
    limieten: opties.limieten,
    door: goedkeurderKlant(gebruiker.email),
  });
}

export async function wijsAfVoorKlant(
  db: Backend,
  gebruiker: PortaalGebruikerContext,
  actieId: string,
  reden: string,
  opties: { limieten: Limieten },
): Promise<Actie> {
  await eisConcept(db, gebruiker.clientId, actieId);
  return await wijsAf(db, actieId, reden, {
    limieten: opties.limieten,
    door: goedkeurderKlant(gebruiker.email),
  });
}

/**
 * "Alles goedkeuren": de ids die op de pagina stonden. Hoort er één niet bij
 * de klant (of is hij geen open concept meer), dan wordt níets goedgekeurd.
 */
export async function keurAllesGoedVoorKlant(
  db: Backend,
  gebruiker: PortaalGebruikerContext,
  actieIds: readonly string[],
  opties: { limieten: Limieten; klok: Klok },
): Promise<GoedkeurBatchResultaat> {
  const uniek = [...new Set(actieIds)];
  if (uniek.length === 0) return { goedgekeurd: [], overgeslagen: [] };
  const gevonden = await openConceptenVanKlant(db, gebruiker.clientId, uniek);
  if (uniek.some((id) => !gevonden.has(id))) {
    throw new PortaalNietGevondenFout(
      'Een of meer concepten bestaan niet (meer) of horen niet bij uw organisatie; er is niets goedgekeurd. Laad de pagina opnieuw.',
    );
  }
  return await goedkeurBatch(db, uniek, {
    klok: opties.klok,
    limieten: opties.limieten,
    door: goedkeurderKlant(gebruiker.email),
  });
}

export class PortaalKoppelFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'PortaalKoppelFout';
  }
}

export interface OpnieuwKoppelenDeps {
  db: Backend;
  unipile: UnipileClient;
  koppelOpties: KoppelflowOpties;
  uitnodigingOpties: UitnodigingOpties;
  klok: Klok;
}

/**
 * Link om een account (opnieuw) te koppelen:
 * - sessie verlopen (`CREDENTIALS`) → Unipile reconnect-link (§6 punt 4);
 * - nog niet gekoppeld → nieuwe koppeluitnodiging van de gateway (§14.2), zodat
 *   de toestemming eerst op de koppelpagina wordt vastgelegd. Geeft een relatief
 *   pad `/koppelen/<token>`.
 * Andere standen: `PortaalKoppelFout` met uitleg.
 */
export async function maakKoppellinkVoorKlant(
  deps: OpnieuwKoppelenDeps,
  clientId: string,
  accountId: string,
): Promise<{ url: string }> {
  if (!isUuid(accountId)) throw new PortaalNietGevondenFout('Onbekend account; er is niets gewijzigd.');
  const account = (await accountsVanKlant(deps.db, clientId)).find((a) => a.id === accountId);
  if (!account) throw new PortaalNietGevondenFout('Onbekend account; er is niets gewijzigd.');
  const stand = bepaalStand(
    {
      gekoppeld: account.unipile_account_id !== null,
      status: account.status,
      afkoelingTot: account.afkoeling_tot === null ? null : new Date(account.afkoeling_tot),
      opbouwFactor: Number(account.opbouw_factor),
    },
    deps.klok.nu(),
  );
  if (!kanOpnieuwKoppelen(stand)) {
    throw new PortaalKoppelFout(
      `Het account van ${account.eigenaar_naam} is gekoppeld; opnieuw koppelen is niet nodig.`,
    );
  }
  if (stand === 'niet_gekoppeld') {
    const uitnodiging = await maakNieuweKoppeluitnodiging(deps.db, accountId, deps.uitnodigingOpties);
    return { url: `/koppelen/${uitnodiging.token}` };
  }
  return await maakReconnectLink(deps.db, deps.unipile, deps.koppelOpties, accountId);
}
