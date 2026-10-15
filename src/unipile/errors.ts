export type UnipileFoutSoort =
  | 'tijdelijk'
  | 'timeout'
  | 'api_sleutel'
  | 'account_credentials'
  | 'account_beperkt'
  | 'functie_ontbreekt'
  | 'auth_onbekend'
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
 * Onze API-sleutel (Access Token) is ongeldig of verlopen. Gateway-breed: de
 * gateway stopt en meldt bij Rubert. LinkedIn-accounts worden NIET op basis van
 * deze fout gepauzeerd.
 *
 * Sinds SPEC §6a alleen nog bij een 401/403 op een aanroep zonder
 * account-context (bijv. `haalAccounts`, `haalWebhooks`) of op de
 * controle-aanroep `controleerGatewaySleutel`. Een 401/403 op een aanroep
 * voor één account wordt eerst op het `type` geclassificeerd.
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

  constructor(code: string, endpoint: string, accountId?: string, status?: number) {
    const wie = accountId ? `account ${accountId}` : 'dit account';
    super(
      'account_credentials',
      `LinkedIn-sessie voor ${wie} is verlopen of ongeldig (code ${code} op ${endpoint}). Alleen dit account pauzeren en een reconnect-link sturen.`,
      endpoint,
      status,
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
  'expired_credentials',
  'invalid_credentials',
  'missing_credentials',
  'multiple_sessions',
  'checkpoint_error',
  'invalid_checkpoint_solution',
  'wrong_account',
  'session_mismatch',
  'unknown_authentication_context',
  'account_mismatch',
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

/**
 * 400-fouttypes waarmee Unipile een aanvraag zelf afwijst, vóórdat er iets
 * naar LinkedIn gaat (schema POST /api/v1/linkedin/search, docs/unipile-notities.md).
 * Alleen deze types boeken budget terug (SPEC §5.1). `errors/target_audience_too_small`
 * hoort er bewust NIET bij: dan heeft LinkedIn de zoekopdracht uitgevoerd.
 */
export const VALIDATIE_400_VOOR_LINKEDIN: ReadonlySet<string> = new Set([
  'errors/invalid_parameters',
  'errors/malformed_request',
  'errors/missing_parameters',
  'errors/limit_too_high',
  'errors/invalid_url',
  'errors/too_many_characters',
  'errors/unescaped_characters',
  'errors/content_too_large',
]);

/** Leest het veld `type` uit een Unipile-foutbody; undefined als het er niet is. */
export function foutTypeUitBody(raw: string): string | undefined {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && typeof (obj as { type?: unknown }).type === 'string') {
      return (obj as { type: string }).type;
    }
  } catch {
    /* geen JSON */
  }
  return undefined;
}

/**
 * HTTP 400 met een validatietype uit VALIDATIE_400_VOOR_LINKEDIN: Unipile heeft
 * de aanvraag geweigerd vóór LinkedIn. De worker boekt het budget terug.
 */
export class UnipileValidatieFout extends UnipileFout {
  readonly foutType: string;
  readonly detail: string | undefined;

  constructor(foutType: string, endpoint: string, detail?: string) {
    const extra = detail ? `: ${detail.slice(0, 200)}` : '';
    super(
      'validatie',
      `Unipile weigerde de aanvraag vóór LinkedIn (${foutType}${extra}) op ${endpoint}. Pas de aanvraag aan en probeer opnieuw.`,
      endpoint,
      400,
    );
    this.name = 'UnipileValidatieFout';
    this.foutType = foutType;
    this.detail = detail;
  }
}

// -- 401/403 per account (SPEC §6a) --------------------------------------------

/**
 * Fouttypes (zonder `errors/`) waarmee Unipile meldt dat de LinkedIn-sessie van
 * één account niet werkt. Gevolg: alleen dat account naar `CREDENTIALS`.
 */
export const SESSIE_AUTH_TYPES: ReadonlySet<string> = new Set([
  'disconnected_account',
  'expired_credentials',
  'invalid_credentials',
  'missing_credentials',
  'multiple_sessions',
  'checkpoint_error',
  'invalid_checkpoint_solution',
  'wrong_account',
  'session_mismatch',
  'unknown_authentication_context',
  'account_mismatch',
]);

/** LinkedIn heeft het account beperkt. Gevolg: account naar `STOPPED`, geen reconnect. */
export const BEPERKT_AUTH_TYPE = 'account_restricted';

/**
 * De functie hoort niet bij het LinkedIn-abonnement van dit account (bijv.
 * Sales Navigator-zoeken of InMail op een gewoon account). Gevolg: alleen de
 * actie `failed`; het account blijft `OK`.
 */
export const FUNCTIE_AUTH_TYPES: ReadonlySet<string> = new Set([
  'feature_not_subscribed',
  'insufficient_permissions',
  'insufficient_privileges',
  'disconnected_feature',
]);

export type AuthFoutKlasse = 'sessie' | 'beperkt' | 'functie' | 'onbekend';

/** `errors/expired_credentials` → `expired_credentials`; undefined blijft undefined. */
export function kaalFoutType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  const t = type.trim();
  if (t === '') return undefined;
  return t.startsWith('errors/') ? t.slice('errors/'.length) : t;
}

/** Classificeert het `type` uit de body van een 401/403 (SPEC §6a, tabel). */
export function classificeerAuthType(type: string | undefined): AuthFoutKlasse {
  const kaal = kaalFoutType(type);
  if (kaal === undefined) return 'onbekend';
  if (SESSIE_AUTH_TYPES.has(kaal)) return 'sessie';
  if (kaal === BEPERKT_AUTH_TYPE) return 'beperkt';
  if (FUNCTIE_AUTH_TYPES.has(kaal)) return 'functie';
  return 'onbekend';
}

/** 403 `account_restricted`: LinkedIn heeft dit account beperkt. */
export class UnipileAccountBeperktFout extends UnipileFout {
  readonly foutType: string;
  readonly accountId: string | undefined;

  constructor(endpoint: string, status: number, accountId?: string) {
    const wie = accountId ? `account ${accountId}` : 'dit account';
    super(
      'account_beperkt',
      `LinkedIn heeft ${wie} beperkt (HTTP ${status} errors/${BEPERKT_AUTH_TYPE} op ${endpoint}). Alleen dit account stopgezet; de eigenaar moet eerst zelf in LinkedIn kijken.`,
      endpoint,
      status,
    );
    this.name = 'UnipileAccountBeperktFout';
    this.foutType = `errors/${BEPERKT_AUTH_TYPE}`;
    this.accountId = accountId;
  }
}

/** 401/403 voor een functie die niet in het LinkedIn-abonnement van dit account zit. */
export class UnipileFunctieNietInAbonnementFout extends UnipileFout {
  readonly foutType: string;
  readonly accountId: string | undefined;

  constructor(foutType: string, endpoint: string, status: number, accountId?: string) {
    super(
      'functie_ontbreekt',
      `Deze functie zit niet in het LinkedIn-abonnement van dit account (HTTP ${status} ${foutType} op ${endpoint}). De actie is niet uitgevoerd; het account blijft actief.`,
      endpoint,
      status,
    );
    this.name = 'UnipileFunctieNietInAbonnementFout';
    this.foutType = foutType;
    this.accountId = accountId;
  }
}

/**
 * 401/403 op een aanroep voor één account zonder (bekend) `type`. Of het aan
 * het account of aan onze sleutel ligt, beslist de controle-aanroep
 * (`controleerGatewaySleutel`, SPEC §6a).
 */
export class UnipileOnbekendeAuthFout extends UnipileFout {
  readonly foutType: string | undefined;
  readonly accountId: string | undefined;

  constructor(status: number, foutType: string | undefined, endpoint: string, accountId?: string) {
    const typeTekst = foutType ? `type ${foutType}` : 'zonder type';
    super(
      'auth_onbekend',
      `Unipile weigerde de aanvraag (HTTP ${status}, ${typeTekst}) op ${endpoint}; nog onbekend of het aan dit account of aan de gateway-sleutel ligt.`,
      endpoint,
      status,
    );
    this.name = 'UnipileOnbekendeAuthFout';
    this.foutType = foutType;
    this.accountId = accountId;
  }
}

export type UnipileAccountAuthFout =
  | UnipileAccountCredentialsFout
  | UnipileAccountBeperktFout
  | UnipileFunctieNietInAbonnementFout
  | UnipileOnbekendeAuthFout;

/** Een 401/403 (of sessiemelding) die over één account gaat, niet over de gateway. */
export function isAccountAuthFout(err: unknown): err is UnipileAccountAuthFout {
  return (
    err instanceof UnipileAccountCredentialsFout ||
    err instanceof UnipileAccountBeperktFout ||
    err instanceof UnipileFunctieNietInAbonnementFout ||
    err instanceof UnipileOnbekendeAuthFout
  );
}

/** Bouwt de juiste fout voor een 401/403 op een aanroep met account-context. */
export function maakAccountAuthFout(
  status: number,
  foutType: string | undefined,
  endpoint: string,
  accountId: string,
): UnipileAccountAuthFout {
  const kaal = kaalFoutType(foutType);
  switch (classificeerAuthType(foutType)) {
    case 'sessie':
      return new UnipileAccountCredentialsFout(kaal ?? 'onbekend', endpoint, accountId, status);
    case 'beperkt':
      return new UnipileAccountBeperktFout(endpoint, status, accountId);
    case 'functie':
      return new UnipileFunctieNietInAbonnementFout(`errors/${kaal}`, endpoint, status, accountId);
    case 'onbekend':
      return new UnipileOnbekendeAuthFout(status, foutType, endpoint, accountId);
  }
}
