/**
 * Tijdzone van een LinkedIn-account (SPEC §14.2a): een IANA-naam zoals
 * `Europe/London`. Gedeeld door "Nieuwe klant" en "Account toevoegen".
 */

export const STANDAARD_TIJDZONE = 'Europe/Amsterdam';

/** Vaste keuzes in de admin; elke andere geldige IANA-naam mag ook. */
export const TIJDZONE_KEUZES: readonly string[] = [
  'Europe/Amsterdam',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Brussels',
];

// Intl accepteert ook offsets als "+01:00"; dat zijn geen IANA-namen en die
// volgen geen zomertijd. Alleen letters, cijfers, _ + - en slashes.
const IANA_PATROON = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

function melding(naam: string): string {
  return (
    `"${naam}" is geen geldige tijdzone. Kies er een uit de lijst of vul een IANA-naam in, ` +
    'bijvoorbeeld Europe/Amsterdam of America/New_York.'
  );
}

/** `null` als `naam` een geldige IANA-tijdzone is, anders een NL-melding. */
export function valideerTijdzone(naam: string): string | null {
  if (!naam || naam.length > 64 || !IANA_PATROON.test(naam)) return melding(naam);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: naam });
  } catch (err) {
    if (err instanceof RangeError) return melding(naam);
    throw err;
  }
  return null;
}

/**
 * Leest de tijdzone uit invoer: leeg → Europe/Amsterdam; anders getrimd,
 * gevalideerd en in de gangbare schrijfwijze (`europe/london` → `Europe/London`).
 */
export function leesTijdzone(invoer: string | undefined): { tijdzone: string } | { fout: string } {
  const naam = (invoer ?? '').trim();
  if (!naam) return { tijdzone: STANDAARD_TIJDZONE };
  const fout = valideerTijdzone(naam);
  if (fout) return { fout };
  return { tijdzone: new Intl.DateTimeFormat('en-US', { timeZone: naam }).resolvedOptions().timeZone };
}
