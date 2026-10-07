import { REDEN_NIET_ACTIEF, verzendenToegestaan, type Betaalpoort } from '../abonnement/abonnementen.ts';
import type { Abonnement } from '../register/accounts.ts';
import type { AccountStatus } from '../register/status.ts';

import { inAfkoeling } from './afkoeling.ts';
import type { ActieType, AbonnementLimieten, Limieten } from './limits.ts';
import { geschaaldeNorm, weekBudgetMetBonus } from './opbouw.ts';
import { binnenWerkuren, isWerkdag } from './tijdvenster.ts';

/**
 * Zes controles uit SPEC §5, in deze volgorde:
 * 1. account_gezond — status van het Unipile-account.
 *    1a. abonnement — betaalpoort (SPEC §14.4): bij klanten met
 *    `abonnement_vereist` alleen verzending (invite/message/inmail) als het
 *    abonnement `trialing`, `active` of `past_due` is. Anders wachtrij: de
 *    actie blijft geparkeerd tot er een actief abonnement is.
 * 2. goedgekeurd — invite/message/inmail vereist menselijke goedkeuring.
 * 3. dagbudget — vandaag niet over de norm (incl. openstaand ≥ 500 voor
 *    invites en het Unipile-usage-signaal ≥ 75%). Voor InMail is dit het
 *    maandbudget per abonnement (zie docs/limieten.md).
 * 4. weekbudget — schuivend over 7 dagen; met bonus voor Sales Navigator.
 * 5. tijdvenster — werkdag, werkuren in de tijdzone van het account, en
 *    minimale pauze sinds de vorige actie.
 * 6. afkoeling — na 429/captcha/waarschuwing 48 uur stop (SPEC §5).
 *
 * Resultaat:
 * - `toegestaan`: actie mag nu.
 * - `wachtrij`: tijdelijk; het heeft zin om later opnieuw te proberen.
 * - `weigering`: structureel; opnieuw aanbieden heeft geen zin tot er iets
 *   aan het onderliggende probleem is veranderd (reconnect, nieuwe
 *   goedkeuring, maandwissel voor InMail-tegoed, …).
 *
 * De `controle`-sleutel wijst naar de regel die het resultaat bepaalde,
 * zodat tests de volgorde van SPEC §5 kunnen afdwingen.
 */

export type BeoordelingStatus = 'toegestaan' | 'wachtrij' | 'weigering';

export type ControleNaam =
  | 'account_gezond'
  | 'abonnement'
  | 'goedgekeurd'
  | 'dagbudget'
  | 'weekbudget'
  | 'tijdvenster'
  | 'afkoeling';

export type Beoordeling =
  | { status: 'toegestaan' }
  | {
      status: 'wachtrij';
      controle: ControleNaam;
      reden: string;
      structureel: false;
    }
  | {
      status: 'weigering';
      controle: ControleNaam;
      reden: string;
      structureel: true;
    };

export interface BeoordelingsInvoer {
  account: {
    status: AccountStatus;
    abonnement: Abonnement;
    opbouwFactor: number;
    afkoelingTot: Date | null;
    tijdzone: string;
    openstaandeVerzoeken: number;
  };
  actieType: ActieType;
  goedgekeurd: boolean;
  nu: Date;
  gebruikDag: number;
  gebruikWeek: number;
  gebruikMaand: number;
  laatsteActieOp: Date | null;
  minPauzeSeconden: number;
  typeDagStop: boolean;
  wekenSindsStart: number;
  acceptatieVerhouding: number;
  limieten: Limieten;
  /**
   * Betaalpoort van de klant (SPEC §14.4). Ontbreekt hij, dan geldt geen
   * betaalpoort (pure unittests); src/budget/verbruik.ts vult hem altijd.
   */
  betaalpoort?: Betaalpoort;
}

export function beoordeel(invoer: BeoordelingsInvoer): Beoordeling {
  const uitslag =
    controle1AccountGezond(invoer) ??
    controle1aAbonnement(invoer) ??
    controle2Goedgekeurd(invoer) ??
    controle3Dagbudget(invoer) ??
    controle4Weekbudget(invoer) ??
    controle5Tijdvenster(invoer) ??
    controle6Afkoeling(invoer);
  return uitslag ?? { status: 'toegestaan' };
}

// -- controle 1 --------------------------------------------------------------

function controle1AccountGezond(invoer: BeoordelingsInvoer): Beoordeling | null {
  const status = invoer.account.status;
  switch (status) {
    case 'OK':
    case 'RECONNECTED':
      return null;
    case 'CREDENTIALS':
      return weigering(
        'account_gezond',
        'LinkedIn-sessie is verlopen; account opnieuw koppelen voordat acties doorgaan.',
      );
    case 'ERROR':
      return weigering(
        'account_gezond',
        'Account staat op fout (ERROR) bij Unipile; eerst oorzaak opzoeken en herstellen.',
      );
    case 'STOPPED':
      return weigering(
        'account_gezond',
        'Account is gestopt; door Rubert heractiveren voordat acties lopen.',
      );
    case 'PERMISSIONS':
      return weigering(
        'account_gezond',
        'Account mist LinkedIn-permissies; eigenaar moet toestemming geven voor Unipile.',
      );
    case 'CONNECTING':
      return wachtrij(
        'account_gezond',
        'Account is nog aan het verbinden (CONNECTING); wacht op bevestiging van de koppeling.',
      );
    case 'UNKNOWN':
    default:
      return wachtrij(
        'account_gezond',
        'Accountstatus is onbekend; wacht op volgende statusbericht van Unipile.',
      );
  }
}

// -- controle 1a: betaalpoort ------------------------------------------------

const VERZENDTYPEN: ReadonlySet<ActieType> = new Set(['invite', 'message', 'inmail'] as const);

function controle1aAbonnement(invoer: BeoordelingsInvoer): Beoordeling | null {
  if (!invoer.betaalpoort) return null;
  if (!VERZENDTYPEN.has(invoer.actieType)) return null;
  if (verzendenToegestaan(invoer.betaalpoort)) return null;
  // Parkeren, niet afwijzen: zodra er een actief abonnement is, gaat de actie alsnog.
  return wachtrij('abonnement', REDEN_NIET_ACTIEF);
}

// -- controle 2 --------------------------------------------------------------

function controle2Goedgekeurd(invoer: BeoordelingsInvoer): Beoordeling | null {
  const vereist: ReadonlySet<ActieType> = new Set(['invite', 'message', 'inmail'] as const);
  if (!vereist.has(invoer.actieType)) return null;
  if (invoer.goedgekeurd) return null;
  return weigering(
    'goedgekeurd',
    `Actietype "${invoer.actieType}" vereist expliciete goedkeuring; actie zonder goedkeuring hoort niet in de wachtrij.`,
  );
}

// -- controle 3 --------------------------------------------------------------

function controle3Dagbudget(invoer: BeoordelingsInvoer): Beoordeling | null {
  const abn = abonnementLimieten(invoer);

  if (invoer.typeDagStop) {
    return wachtrij(
      'dagbudget',
      `Unipile meldde usage ≥ ${invoer.limieten.unipile_usage_signaal.afremmen_bij_percentage}%; actietype "${invoer.actieType}" vandaag afremmen tot morgen.`,
    );
  }

  if (invoer.actieType === 'invite') {
    const grens = abn.invite.openstaand_maximum;
    if (invoer.account.openstaandeVerzoeken >= grens) {
      return wachtrij(
        'dagbudget',
        `Account heeft ${invoer.account.openstaandeVerzoeken} openstaande verzoeken; wacht tot er onder ${grens} openstaan voordat nieuwe uitnodigingen vertrekken.`,
      );
    }
  }

  if (invoer.actieType === 'inmail') {
    const maandnorm = abn.inmail.maand;
    if (maandnorm === 0) {
      return wachtrij(
        'dagbudget',
        `Abonnement "${invoer.account.abonnement}" bevat geen InMail-tegoed; actietype inmail vereist een Premium- of Sales Navigator-abonnement.`,
      );
    }
    if (invoer.gebruikMaand + 1 > maandnorm) {
      return wachtrij(
        'dagbudget',
        `Maandbudget voor InMail is op (${invoer.gebruikMaand}/${maandnorm}); wacht tot volgende kalendermaand of tot er tegoed terugkomt.`,
      );
    }
    return null;
  }

  const dagnorm = dagnormVoorType(invoer, abn);
  if (dagnorm === null) return null;
  if (invoer.gebruikDag + 1 > dagnorm) {
    return wachtrij(
      'dagbudget',
      `Dagnorm voor "${invoer.actieType}" bereikt (${invoer.gebruikDag}/${dagnorm}); wacht tot morgen in de tijdzone van het account.`,
    );
  }
  return null;
}

function dagnormVoorType(invoer: BeoordelingsInvoer, abn: AbonnementLimieten): number | null {
  const factor = invoer.account.opbouwFactor;
  switch (invoer.actieType) {
    case 'invite':
      return geschaaldeNorm(abn.invite.dag, factor);
    case 'message':
      return geschaaldeNorm(abn.message.dag, factor);
    case 'profile':
      return geschaaldeNorm(abn.profile.dag, factor);
    case 'search':
      return geschaaldeNorm(abn.search.runs_per_dag, factor);
    case 'inmail':
      return null;
  }
}

// -- controle 4 --------------------------------------------------------------

function controle4Weekbudget(invoer: BeoordelingsInvoer): Beoordeling | null {
  if (invoer.actieType === 'inmail' || invoer.actieType === 'search') return null;
  const abn = abonnementLimieten(invoer);
  const weeknorm = weeknormVoorType(invoer, abn);
  if (weeknorm === null) return null;
  if (invoer.gebruikWeek + 1 > weeknorm) {
    return wachtrij(
      'weekbudget',
      `Weeknorm voor "${invoer.actieType}" bereikt (${invoer.gebruikWeek}/${weeknorm}); wacht tot de oudste dag uit het 7-daagse venster valt.`,
    );
  }
  return null;
}

function weeknormVoorType(invoer: BeoordelingsInvoer, abn: AbonnementLimieten): number | null {
  const factor = invoer.account.opbouwFactor;
  switch (invoer.actieType) {
    case 'invite':
      return weekBudgetMetBonus({
        invite: abn.invite,
        opbouwFactor: factor,
        wekenSindsStart: invoer.wekenSindsStart,
        acceptatieVerhouding: invoer.acceptatieVerhouding,
      });
    case 'message':
      return geschaaldeNorm(abn.message.week, factor);
    case 'profile':
      return geschaaldeNorm(abn.profile.week, factor);
    case 'search':
    case 'inmail':
      return null;
  }
}

// -- controle 5 --------------------------------------------------------------

function controle5Tijdvenster(invoer: BeoordelingsInvoer): Beoordeling | null {
  const tz = invoer.account.tijdzone;
  const venster = invoer.limieten.tijdvenster;
  if (!isWerkdag(invoer.nu, tz, venster.werkdagen)) {
    return wachtrij(
      'tijdvenster',
      `Buiten werkdagen in tijdzone ${tz}; wacht tot de eerstvolgende werkdag.`,
    );
  }
  if (!binnenWerkuren(invoer.nu, tz, venster.start_lokaal, venster.einde_lokaal)) {
    return wachtrij(
      'tijdvenster',
      `Buiten werkuren (${venster.start_lokaal}–${venster.einde_lokaal} in tijdzone ${tz}); wacht tot het volgende werkuur.`,
    );
  }
  if (invoer.laatsteActieOp) {
    const sinds = Math.floor((invoer.nu.getTime() - invoer.laatsteActieOp.getTime()) / 1000);
    if (sinds < invoer.minPauzeSeconden) {
      const resterendMin = Math.ceil((invoer.minPauzeSeconden - sinds) / 60);
      return wachtrij(
        'tijdvenster',
        `Vorige actie was ${Math.floor(sinds / 60)} minuten geleden; minPauze van ${Math.floor(invoer.minPauzeSeconden / 60)} minuten tussen acties vereist nog ongeveer ${resterendMin} minuten geduld.`,
      );
    }
  }
  return null;
}

// -- controle 6 --------------------------------------------------------------

function controle6Afkoeling(invoer: BeoordelingsInvoer): Beoordeling | null {
  if (!inAfkoeling({ afkoelingTot: invoer.account.afkoelingTot }, invoer.nu)) return null;
  const totISO = invoer.account.afkoelingTot?.toISOString() ?? 'onbekend';
  return wachtrij(
    'afkoeling',
    `Account staat in afkoeling na 429/captcha/waarschuwing tot ${totISO}; 48 uur pauze gevolgd door opbouwperiode.`,
  );
}

// -- hulpfuncties ------------------------------------------------------------

function abonnementLimieten(invoer: BeoordelingsInvoer): AbonnementLimieten {
  const abn = invoer.limieten.abonnementen[invoer.account.abonnement];
  if (!abn) {
    throw new Error(
      `Abonnement "${invoer.account.abonnement}" ontbreekt in de limieten-configuratie.`,
    );
  }
  return abn;
}

function wachtrij(controle: ControleNaam, reden: string): Beoordeling {
  return { status: 'wachtrij', controle, reden, structureel: false };
}

function weigering(controle: ControleNaam, reden: string): Beoordeling {
  return { status: 'weigering', controle, reden, structureel: true };
}
