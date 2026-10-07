/**
 * Fouten van de Stripe-client (SPEC §14.4), in dezelfde opzet als
 * src/unipile/errors.ts: één basisklasse met een `soort`, NL-meldingen met
 * oorzaak en vervolgstap. Meldingen bevatten nooit sleutels of headers.
 */

export type StripeFoutSoort = 'tijdelijk' | 'timeout' | 'api_sleutel' | 'verzoek' | 'onverwacht';

export class StripeFout extends Error {
  readonly soort: StripeFoutSoort;
  readonly endpoint: string;
  readonly status: number | undefined;
  /** Stripe-foutcode (`error.code`), bijv. `resource_missing`. */
  readonly code: string | undefined;

  constructor(soort: StripeFoutSoort, bericht: string, endpoint: string, status?: number, code?: string) {
    super(bericht);
    this.name = 'StripeFout';
    this.soort = soort;
    this.endpoint = endpoint;
    this.status = status;
    this.code = code;
  }
}

/** 429, 5xx of netwerkfout: later opnieuw proberen heeft zin. */
export class StripeTijdelijkeFout extends StripeFout {
  constructor(bericht: string, endpoint: string, status?: number) {
    super('tijdelijk', bericht, endpoint, status);
    this.name = 'StripeTijdelijkeFout';
  }
}

export class StripeTimeoutFout extends StripeFout {
  readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number) {
    super(
      'timeout',
      `Stripe antwoordde niet binnen ${timeoutMs} ms op ${endpoint}; probeer het over enkele minuten opnieuw.`,
      endpoint,
    );
    this.name = 'StripeTimeoutFout';
    this.timeoutMs = timeoutMs;
  }
}

/** 401/403: STRIPE_SECRET_KEY ongeldig, ingetrokken of zonder rechten. */
export class StripeSleutelFout extends StripeFout {
  constructor(endpoint: string, status: number) {
    super(
      'api_sleutel',
      `Stripe weigerde de aanvraag (HTTP ${status} op ${endpoint}): STRIPE_SECRET_KEY is ongeldig, ingetrokken of heeft te weinig rechten. Controleer de sleutel in Railway en het Stripe-dashboard.`,
      endpoint,
      status,
    );
    this.name = 'StripeSleutelFout';
  }
}

/** Overige 4xx: het verzoek klopt niet (bijv. onbekende prijs of klant). */
export class StripeVerzoekFout extends StripeFout {
  constructor(bericht: string, endpoint: string, status: number, code?: string) {
    super('verzoek', bericht, endpoint, status, code);
    this.name = 'StripeVerzoekFout';
  }
}

interface StripeFoutBody {
  error?: { type?: string; code?: string; message?: string; param?: string };
}

/** Haalt `error.code`, `error.param` en `error.message` uit een Stripe-foutbody. */
export function foutUitBody(raw: string): { code?: string; param?: string; message?: string } {
  try {
    const body = JSON.parse(raw) as StripeFoutBody;
    const e = body.error ?? {};
    const uit: { code?: string; param?: string; message?: string } = {};
    if (typeof e.code === 'string') uit.code = e.code;
    if (typeof e.param === 'string') uit.param = e.param;
    if (typeof e.message === 'string') uit.message = e.message.slice(0, 200);
    return uit;
  } catch {
    return {};
  }
}
