import { BEEINDIGDE_STATUSSEN, type KlantAbonnement } from './abonnementen.ts';

/**
 * Stand van het abonnement in gewone taal (SPEC §14.3), voor portaal en admin.
 */

export type AbonnementKnop = 'starten' | 'beheren' | null;

export interface AbonnementWeergave {
  /** Korte stand, bijv. "Proefperiode tot 6 november 2026". */
  titel: string;
  uitleg: string;
  soort: 'goed' | 'let-op' | 'actie';
  volgendeBetaling: Date | null;
  knop: AbonnementKnop;
  /** Verzenden gaat door (trialing, active, past_due) of is niet vereist. */
  verzendenToegestaan: boolean;
}

const DATUM = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function datumTekst(d: Date): string {
  return DATUM.format(d);
}

export function beschrijfAbonnement(vereist: boolean, a: KlantAbonnement | null): AbonnementWeergave {
  const status = a?.status ?? null;
  if (!vereist) {
    return {
      titel: 'Geen abonnement nodig',
      uitleg: 'Voor uw organisatie is geen abonnement nodig; berichten worden verstuurd zoals afgesproken.',
      soort: 'goed',
      volgendeBetaling: null,
      knop: null,
      verzendenToegestaan: true,
    };
  }
  if (!a || status === null || BEEINDIGDE_STATUSSEN.has(status)) {
    const beeindigd = status === 'canceled';
    return {
      titel: beeindigd ? 'Abonnement beëindigd' : 'Geen abonnement',
      uitleg:
        (beeindigd ? 'Uw abonnement is beëindigd. ' : '') +
        'Zonder actief abonnement worden er geen connectieverzoeken of berichten verstuurd.',
      soort: 'actie',
      volgendeBetaling: null,
      knop: 'starten',
      verzendenToegestaan: false,
    };
  }
  const opgezegd = a.opgezegdPerEinde;
  switch (status) {
    case 'trialing': {
      const tot = a.proefTot;
      return {
        titel: tot ? `Proefperiode tot ${datumTekst(tot)}` : 'Proefperiode',
        uitleg: opgezegd
          ? `Opgezegd per ${tot ? datumTekst(tot) : 'het einde van de proefperiode'}. Er volgt geen betaling.`
          : 'U betaalt pas na de proefperiode. Zegt u vóór het einde op, dan volgt er geen betaling.',
        soort: 'goed',
        volgendeBetaling: opgezegd ? null : tot,
        knop: 'beheren',
        verzendenToegestaan: true,
      };
    }
    case 'active':
      return {
        titel: opgezegd && a.periodeTot ? `Opgezegd per ${datumTekst(a.periodeTot)}` : 'Actief',
        uitleg: opgezegd
          ? 'Tot die datum loopt alles door; daarna stopt het versturen.'
          : 'Uw abonnement is actief.',
        soort: opgezegd ? 'let-op' : 'goed',
        volgendeBetaling: opgezegd ? null : a.periodeTot,
        knop: 'beheren',
        verzendenToegestaan: true,
      };
    case 'past_due':
      return {
        titel: 'Betaling mislukt',
        uitleg:
          'De laatste betaling is niet gelukt. Werk uw betaalgegevens bij via "Abonnement beheren"; anders stopt het versturen.',
        soort: 'let-op',
        volgendeBetaling: null,
        knop: 'beheren',
        verzendenToegestaan: true,
      };
    case 'unpaid':
      return {
        titel: 'Niet betaald',
        uitleg: 'Er staan onbetaalde facturen open; er wordt niets verstuurd. Betaal via "Abonnement beheren".',
        soort: 'actie',
        volgendeBetaling: null,
        knop: 'beheren',
        verzendenToegestaan: false,
      };
    case 'incomplete':
      return {
        titel: 'Betaling nog niet afgerond',
        uitleg: 'De eerste betaling is nog niet afgerond; rond die af via "Abonnement beheren".',
        soort: 'actie',
        volgendeBetaling: null,
        knop: 'beheren',
        verzendenToegestaan: false,
      };
    case 'paused':
      return {
        titel: 'Gepauzeerd',
        uitleg: 'Uw abonnement is gepauzeerd; er wordt niets verstuurd.',
        soort: 'actie',
        volgendeBetaling: null,
        knop: 'beheren',
        verzendenToegestaan: false,
      };
    default:
      return {
        titel: `Onbekende stand (${status})`,
        uitleg: 'Neem contact op met MARKaaS.',
        soort: 'actie',
        volgendeBetaling: null,
        knop: 'beheren',
        verzendenToegestaan: false,
      };
  }
}
