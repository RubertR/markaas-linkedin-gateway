export type UnipileFoutSoort =
  | 'tijdelijk'
  | 'timeout'
  | 'api_sleutel'
  | 'account_credentials'
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

/**
 * 401 of 403 van Unipile: onze API-sleutel is ongeldig of verlopen.
 * Dit is een gateway-breed probleem — de gateway stopt en meldt bij Rubert.
 * LinkedIn-accounts worden NIET op basis van deze fout gepauzeerd.
 */
export class UnipileGatewayAuthFout extends UnipileFout {
  constructor(endpoint: string, status: number) {
    super(
      'api_sleutel',
      `Unipile weigerde de aanvraag (HTTP ${status} op ${endpoint}): onze API-sleutel is ongeldig of verlopen — gateway stopt, meld bij Rubert. LinkedIn-accounts NIET pauzeren op basis van deze fout.`,
      endpoint,
      status,
    );
    this.name = 'UnipileGatewayAuthFout';
  }
}

/**
 * Expliciete melding in het antwoord dat de LinkedIn-sessie van dit
 * ene account niet meer werkt. Alleen dit account op pauze zetten;
 * andere accounts blijven doorlopen.
 * De account_status-webhook (`credentials`) is het andere signaal
 * voor hetzelfde probleem — daar wordt in src/webhooks/ op gereageerd.
 */
export class UnipileAccountCredentialsFout extends UnipileFout {
  readonly code: string;
  readonly accountId: string | undefined;

  constructor(code: string, endpoint: string, accountId?: string) {
    const wie = accountId ? `account ${accountId}` : 'dit account';
    super(
      'account_credentials',
      `LinkedIn-sessie voor ${wie} is verlopen of ongeldig (code ${code} op ${endpoint}). Alleen dit account pauzeren en een reconnect-link sturen.`,
      endpoint,
    );
    this.name = 'UnipileAccountCredentialsFout';
    this.code = code;
    this.accountId = accountId;
  }
}

const BEKENDE_ACCOUNT_CREDS_CODES = [
  'account_credentials',
  'credentials_expired',
  'session_expired',
  'account_disconnected',
  'disconnected_account',
  'credentials',
] as const;

export type AccountCredentialsCode = (typeof BEKENDE_ACCOUNT_CREDS_CODES)[number];

export function accountCredentialsCodeUitBody(raw: string): AccountCredentialsCode | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    for (const code of BEKENDE_ACCOUNT_CREDS_CODES) if (raw.includes(code)) return code;
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
  for (const code of BEKENDE_ACCOUNT_CREDS_CODES) {
    if (gevonden.some((tekst) => tekst === code || tekst.endsWith(`/${code}`))) return code;
  }
  return undefined;
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
