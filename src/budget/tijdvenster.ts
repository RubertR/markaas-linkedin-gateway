/**
 * Tijdvenster-helpers die rekening houden met de tijdzone van het account.
 * Lokale dagen worden gebruikt als sleutel voor dagbudget (SPEC §5 controle 3)
 * en voor het schuivende weekvenster (controle 4). Werkuren en werkdagen
 * (controle 5) worden eveneens lokaal berekend, zodat zomer-/wintertijd geen
 * invloed heeft op de interpretatie van de normen.
 */

interface LokaleDelen {
  jaar: number;
  maand: number;
  dag: number;
  uur: number;
  minuut: number;
  weekdag: number;
}

const WEEKDAG_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function lokaleDelen(datum: Date, tijdzone: string): LokaleDelen {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tijdzone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const kaart: Record<string, string> = {};
  for (const deel of fmt.formatToParts(datum)) {
    if (deel.type !== 'literal') kaart[deel.type] = deel.value;
  }
  const uurKaart = kaart['hour'] ?? '00';
  return {
    jaar: Number(kaart['year']),
    maand: Number(kaart['month']),
    dag: Number(kaart['day']),
    uur: uurKaart === '24' ? 0 : Number(uurKaart),
    minuut: Number(kaart['minute']),
    weekdag: WEEKDAG_INDEX[kaart['weekday'] ?? ''] ?? -1,
  };
}

function formatteerIsoDatum(jaar: number, maand: number, dag: number): string {
  return `${String(jaar).padStart(4, '0')}-${String(maand).padStart(2, '0')}-${String(dag).padStart(2, '0')}`;
}

export function lokaleDag(datum: Date, tijdzone: string): string {
  const { jaar, maand, dag } = lokaleDelen(datum, tijdzone);
  return formatteerIsoDatum(jaar, maand, dag);
}

export function lokaleWeekdag(datum: Date, tijdzone: string): number {
  return lokaleDelen(datum, tijdzone).weekdag;
}

export function isWerkdag(
  datum: Date,
  tijdzone: string,
  werkdagen: readonly number[],
): boolean {
  return werkdagen.includes(lokaleWeekdag(datum, tijdzone));
}

/**
 * Vergelijkt lokale tijd met werkuren. Begin en einde inclusief: 08:30 en 17:30
 * tellen beide als binnen bij `start = '08:30'` en `einde = '17:30'`.
 */
export function binnenWerkuren(
  datum: Date,
  tijdzone: string,
  startLokaal: string,
  eindeLokaal: string,
): boolean {
  const { uur, minuut } = lokaleDelen(datum, tijdzone);
  const nuMin = uur * 60 + minuut;
  const [startMin, eindeMin] = [parseHhMm(startLokaal), parseHhMm(eindeLokaal)];
  return nuMin >= startMin && nuMin <= eindeMin;
}

function parseHhMm(waarde: string): number {
  const [u, m] = waarde.split(':');
  if (u === undefined || m === undefined) {
    throw new Error(`Tijd "${waarde}" moet in formaat uu:mm staan.`);
  }
  const uur = Number(u);
  const minuut = Number(m);
  if (!Number.isInteger(uur) || !Number.isInteger(minuut)) {
    throw new Error(`Tijd "${waarde}" is geen geldige uu:mm-waarde.`);
  }
  return uur * 60 + minuut;
}

/**
 * Geeft een reeks van `aantal` lokale kalenderdagen terug, oplopend tot
 * en met de dag van `datum` in de opgegeven tijdzone.
 */
export function lokaleDagen(datum: Date, tijdzone: string, aantal: number): string[] {
  if (!Number.isInteger(aantal) || aantal < 1) {
    throw new Error('Aantal lokaleDagen moet een positief geheel getal zijn.');
  }
  const vandaag = lokaleDag(datum, tijdzone);
  const [j, m, d] = vandaag.split('-').map(Number) as [number, number, number];
  const reeks: string[] = [];
  for (let offset = aantal - 1; offset >= 0; offset--) {
    const kalender = new Date(Date.UTC(j, m - 1, d - offset));
    reeks.push(
      formatteerIsoDatum(
        kalender.getUTCFullYear(),
        kalender.getUTCMonth() + 1,
        kalender.getUTCDate(),
      ),
    );
  }
  return reeks;
}

/**
 * Alle lokale dagen van de eerste van de maand tot en met vandaag,
 * in de tijdzone van het account.
 */
export function dagenInMaand(datum: Date, tijdzone: string): string[] {
  const { jaar, maand, dag } = lokaleDelen(datum, tijdzone);
  const reeks: string[] = [];
  for (let d = 1; d <= dag; d++) {
    reeks.push(formatteerIsoDatum(jaar, maand, d));
  }
  return reeks;
}

const KORTE_MAANDEN = [
  'jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
] as const;

/**
 * Leesbare datum en tijd in de tijdzone van het account, voor meldingen aan
 * skills en gebruikers: "7 okt 2026 08:00" (korte maand zonder punt, zoals op
 * de goedkeuringspagina, plus jaartal; 24-uursnotatie).
 */
export function formatteerLokaal(datum: Date, tijdzone: string): string {
  const { jaar, maand, dag, uur, minuut } = lokaleDelen(datum, tijdzone);
  const hh = String(uur).padStart(2, '0');
  const mm = String(minuut).padStart(2, '0');
  return `${dag} ${KORTE_MAANDEN[maand - 1]} ${jaar} ${hh}:${mm}`;
}
