export type UnipileFoutSoort =
  | 'tijdelijk'
  | 'timeout'
  | 'credentials'
  | 'validatie'
  | 'onverwacht';

export class UnipileFout extends Error {
  readonly soort: UnipileFoutSoort;
  readonly endpoint: string;
  readonly status: number | undefined;

  constructor(
    soort: UnipileFoutSoort,
    bericht: string,
    endpoint: string,
    status?: number,
  ) {
    super(bericht);
    this.name = 'UnipileFout';
    this.soort = soort;
    this.endpoint = endpoint;
    this.status = status;
  }
}

export class UnipileTijdelijkeFout extends UnipileFout {
  readonly retryAfterSeconden: number | undefined;

  constructor(
    bericht: string,
    endpoint: string,
    status?: number,
    retryAfterSeconden?: number,
  ) {
    super('tijdelijk', bericht, endpoint, status);
    this.name = 'UnipileTijdelijkeFout';
    this.retryAfterSeconden = retryAfterSeconden;
  }
}

export class UnipileTimeoutFout extends UnipileFout {
  readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number) {
    super(
      'timeout',
      `Unipile antwoordde niet binnen ${timeoutMs} ms op ${endpoint} — probeer het over enkele minuten opnieuw.`,
      endpoint,
    );
    this.name = 'UnipileTimeoutFout';
    this.timeoutMs = timeoutMs;
  }
}

export class UnipileAuthFout extends UnipileFout {
  constructor(endpoint: string, status: number) {
    super(
      'credentials',
      `Unipile weigerde de aanvraag (HTTP ${status} op ${endpoint}): sessie verlopen of API-sleutel ongeldig — account opnieuw koppelen.`,
      endpoint,
      status,
    );
    this.name = 'UnipileAuthFout';
  }
}

export type Unipile422Code =
  | 'already_invited_recently'
  | 'already_connected'
  | 'cannot_resend_yet'
  | 'connection_limit_reached'
  | 'limit_exceeded'
  | 'insufficient_credits'
  | 'not_allowed_inmail'
  | 'user_unreachable';

const BERICHTEN_422: Record<Unipile422Code, string> = {
  already_invited_recently:
    'LinkedIn heeft dit verzoek recent al ontvangen; geen nieuw verzoek sturen.',
  already_connected:
    'Deze persoon is al een 1e-graads connectie; geen nieuw verzoek nodig.',
  cannot_resend_yet:
    'Verzoek nog niet opnieuw sturen; LinkedIn vraagt om te wachten.',
  connection_limit_reached:
    'LinkedIn-limiet voor connectieverzoeken bereikt; account gaat in afkoeling.',
  limit_exceeded:
    'LinkedIn-limiet overschreden; account gaat 48 uur in afkoeling.',
  insufficient_credits:
    'Onvoldoende InMail-tegoed op dit account; wachten tot volgende maand of upgraden.',
  not_allowed_inmail:
    'InMail naar deze persoon is niet toegestaan (privacy-instelling of profiel gesloten).',
  user_unreachable:
    'Deze persoon is via dit kanaal niet bereikbaar (mogelijk profiel verwijderd of gedeactiveerd).',
};

export class Unipile422Fout extends UnipileFout {
  readonly code: Unipile422Code | string;

  constructor(code: Unipile422Code | string, bericht: string, endpoint: string) {
    super('validatie', bericht, endpoint, 422);
    this.name = 'Unipile422Fout';
    this.code = code;
  }
}

const BEKENDE_CODES = Object.keys(BERICHTEN_422) as Unipile422Code[];

export function maak422Fout(code: string, endpoint: string): Unipile422Fout {
  const nlBericht =
    (BERICHTEN_422 as Record<string, string>)[code] ??
    `Unipile weigerde de aanvraag (422 ${code}) op ${endpoint}.`;
  return new Unipile422Fout(code, nlBericht, endpoint);
}

export function codeUit422Body(raw: string): string | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    for (const code of BEKENDE_CODES) if (raw.includes(code)) return code;
    return undefined;
  }
  const gevonden: string[] = [];
  const bekijk = (waarde: unknown): void => {
    if (waarde == null) return;
    if (typeof waarde === 'string') gevonden.push(waarde);
    else if (Array.isArray(waarde)) waarde.forEach(bekijk);
    else if (typeof waarde === 'object') Object.values(waarde as object).forEach(bekijk);
  };
  bekijk(obj);
  for (const code of BEKENDE_CODES) {
    if (gevonden.some((tekst) => tekst.includes(code))) return code;
  }
  return undefined;
}
