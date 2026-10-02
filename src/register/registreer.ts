import type { Backend } from '../db/backend.ts';

import {
  markeerAccountGekoppeld,
  registreerAccount,
  vindAccountBijUnipileId,
  type Abonnement,
} from './accounts.ts';
import { maakClient, vindClientBijSlug } from './clients.ts';

/**
 * Registreert een klant en een al bij Unipile gekoppeld account in één keer
 * (`npm run account:registreer`). Idempotent: bestaat de klant (op slug) of
 * het account (op Unipile-id) al, dan blijft die ongemoeid.
 */

export const ABONNEMENTEN: readonly Abonnement[] = [
  'free',
  'premium_career',
  'premium_business',
  'salesnav_core',
  'salesnav_advanced',
] as const;

const TIJDZONE = 'Europe/Amsterdam';

export interface RegistreerKlantInvoer {
  klant: string;
  eigenaar: string;
  unipileId: string;
  abonnement: Abonnement;
}

export type Stap = 'aangemaakt' | 'bestaat_al' | 'zou_aanmaken';

export interface RegistreerKlantUitkomst {
  klant: Stap;
  account: Stap;
  /** Intern account-id; null bij een dry-run als het account nog niet bestaat. */
  accountId: string | null;
}

/** "MARKaaS" → "markaas"; "Acme & Zn. B.V." → "acme-zn-b-v". */
export function maakSlug(naam: string): string {
  return naam
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function registreerKlantEnAccount(
  db: Backend,
  invoer: RegistreerKlantInvoer,
  opties: { dryRun?: boolean } = {},
): Promise<RegistreerKlantUitkomst> {
  const slug = maakSlug(invoer.klant);
  if (!slug) {
    throw new Error(`Klantnaam "${invoer.klant}" levert geen bruikbare slug op; kies een naam met letters of cijfers.`);
  }

  if (opties.dryRun) {
    const klant = await vindClientBijSlug(db, slug);
    const account = await vindAccountBijUnipileId(db, invoer.unipileId);
    if (account && klant && account.clientId !== klant.id) throw andereKlantFout(invoer);
    return {
      klant: klant ? 'bestaat_al' : 'zou_aanmaken',
      account: account ? 'bestaat_al' : 'zou_aanmaken',
      accountId: account?.id ?? null,
    };
  }

  return await db.transaction(async (tx) => {
    const bestaandeKlant = await vindClientBijSlug(tx, slug);
    const klant = bestaandeKlant ?? (await maakClient(tx, { naam: invoer.klant.trim(), slug }));

    const bestaandAccount = await vindAccountBijUnipileId(tx, invoer.unipileId);
    if (bestaandAccount) {
      if (bestaandAccount.clientId !== klant.id) throw andereKlantFout(invoer);
      return {
        klant: bestaandeKlant ? 'bestaat_al' : 'aangemaakt',
        account: 'bestaat_al',
        accountId: bestaandAccount.id,
      };
    }

    // opbouw_factor blijft op de schemastandaard 0.50 (nieuw account).
    const account = await registreerAccount(tx, {
      clientId: klant.id,
      eigenaarNaam: invoer.eigenaar.trim(),
      abonnement: invoer.abonnement,
      tijdzone: TIJDZONE,
    });
    await markeerAccountGekoppeld(tx, account.id, invoer.unipileId);
    return {
      klant: bestaandeKlant ? 'bestaat_al' : 'aangemaakt',
      account: 'aangemaakt',
      accountId: account.id,
    };
  });
}

function andereKlantFout(invoer: RegistreerKlantInvoer): Error {
  return new Error(
    `Unipile-id "${invoer.unipileId}" hoort al bij een account van een andere klant dan "${invoer.klant}". ` +
      'Er is niets aangemaakt; controleer het Unipile-id of de klantnaam.',
  );
}

const OPTIES = {
  '--klant': 'klant',
  '--eigenaar': 'eigenaar',
  '--unipile-id': 'unipileId',
  '--abonnement': 'abonnement',
} as const;

/**
 * Leest de CLI-argumenten. Verzamelt alle problemen in één melding, zodat je
 * ze in één ronde kunt herstellen.
 */
export function parseerArgumenten(argv: readonly string[]): {
  invoer: RegistreerKlantInvoer;
  dryRun: boolean;
} {
  const waarden: Partial<Record<(typeof OPTIES)[keyof typeof OPTIES], string>> = {};
  const meldingen: string[] = [];
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const veld = OPTIES[arg as keyof typeof OPTIES];
    if (!veld) {
      meldingen.push(`Onbekende optie ${arg}.`);
      continue;
    }
    const waarde = argv[i + 1];
    if (waarde === undefined || waarde.startsWith('--') || waarde.trim() === '') {
      meldingen.push(`Optie ${arg} heeft geen waarde.`);
      continue;
    }
    waarden[veld] = waarde;
    i++;
  }

  for (const [optie, veld] of Object.entries(OPTIES)) {
    if (waarden[veld] === undefined && !meldingen.some((m) => m.includes(optie))) {
      meldingen.push(`Optie ${optie} ontbreekt.`);
    }
  }

  const abonnement = waarden.abonnement;
  if (abonnement !== undefined && !ABONNEMENTEN.includes(abonnement as Abonnement)) {
    meldingen.push(`Onbekend abonnement "${abonnement}". Kies uit: ${ABONNEMENTEN.join(', ')}.`);
  }

  if (meldingen.length > 0) {
    throw new Error(
      `${meldingen.join('\n')}\nGebruik: npm run account:registreer -- --klant "<naam>" --eigenaar "<naam>" ` +
        '--unipile-id <id> --abonnement <abonnement> [--dry-run]',
    );
  }

  return {
    invoer: {
      klant: waarden.klant!,
      eigenaar: waarden.eigenaar!,
      unipileId: waarden.unipileId!,
      abonnement: abonnement as Abonnement,
    },
    dryRun,
  };
}
