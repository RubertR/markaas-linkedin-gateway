import {
  StripeFout,
  StripeSleutelFout,
  StripeTijdelijkeFout,
  StripeTimeoutFout,
  StripeVerzoekFout,
  foutUitBody,
} from './errors.ts';
import { stripeForm, type FormWaarde } from './form.ts';

/**
 * Dunne client voor de Stripe-API (SPEC §14.4). Alle Stripe-aanroepen van de
 * gateway lopen via deze module (zelfde regel als src/unipile/). Geen
 * stripe-npm-pakket: `fetch` tegen `https://api.stripe.com/v1` met
 * form-encoded bodies en `Authorization: Bearer <STRIPE_SECRET_KEY>`, zoals
 * Stripe documenteert. De basis-URL is injecteerbaar voor test/fake-stripe/.
 *
 * Er wordt geen `Stripe-Version` meegestuurd: de API-versie van het
 * Stripe-account geldt. Velden die tussen versies verhuisd zijn (zoals
 * `current_period_end`) leest src/abonnement/ op beide plekken.
 */

export const STRIPE_API_URL = 'https://api.stripe.com';

export interface StripeOpties {
  secretKey: string;
  /** Standaard https://api.stripe.com (zonder /v1). */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface StripeKlant {
  id: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
  deleted?: boolean;
}

export interface StripeAbonnement {
  id: string;
  customer: string;
  status: string;
  trial_end: number | null;
  /** Oudere API-versies: op het abonnement. Nieuwere: per item (zie `items`). */
  current_period_end?: number | null;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ current_period_end?: number | null; quantity?: number }> };
}

export interface StripeSessie {
  id: string;
  url: string;
}

export interface KlantAanvraag {
  clientId: string;
  naam: string;
  email?: string;
}

export interface CheckoutAanvraag {
  clientId: string;
  customerId: string;
  priceId: string;
  aantal: number;
  /** 0 = geen proefperiode meegeven. */
  proefperiodeDagen: number;
  successUrl: string;
  cancelUrl: string;
}

export interface PortaalAanvraag {
  customerId: string;
  returnUrl: string;
}

export interface StripeClient {
  maakKlant(aanvraag: KlantAanvraag): Promise<StripeKlant>;
  /** `null` als de klant niet (meer) bestaat of verwijderd is. */
  haalKlant(customerId: string): Promise<StripeKlant | null>;
  maakCheckoutSessie(aanvraag: CheckoutAanvraag): Promise<StripeSessie>;
  maakPortaalSessie(aanvraag: PortaalAanvraag): Promise<StripeSessie>;
  haalAbonnement(subscriptionId: string): Promise<StripeAbonnement>;
}

const STANDAARD_TIMEOUT_MS = 10_000;

export function maakStripeClient(opties: StripeOpties): StripeClient {
  const baseUrl = (opties.baseUrl ?? STRIPE_API_URL).replace(/\/+$/, '');
  const timeoutMs = opties.timeoutMs ?? STANDAARD_TIMEOUT_MS;

  async function verzoek<T>(method: 'GET' | 'POST', pad: string, velden?: Record<string, FormWaarde>): Promise<T> {
    const endpoint = `${method} ${pad.replace(/\/(cus|sub|cs|bps)_[A-Za-z0-9_]+/g, '/{id}')}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opties.secretKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (velden) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = stripeForm(velden);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init.signal = ctrl.signal;
    let res: Response;
    let raw: string;
    try {
      res = await fetch(`${baseUrl}${pad}`, init);
      raw = await res.text();
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw new StripeTimeoutFout(endpoint, timeoutMs);
      throw new StripeTijdelijkeFout(
        `Kon Stripe niet bereiken voor ${endpoint}; probeer het over enkele minuten opnieuw.`,
        endpoint,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) throw new StripeSleutelFout(endpoint, res.status);
    if (res.status === 429) {
      throw new StripeTijdelijkeFout(
        `Stripe vroeg om te vertragen (HTTP 429) op ${endpoint}; probeer het over een minuut opnieuw.`,
        endpoint,
        429,
      );
    }
    if (res.status >= 500) {
      throw new StripeTijdelijkeFout(
        `Stripe-serverfout (HTTP ${res.status}) op ${endpoint}; probeer het over enkele minuten opnieuw.`,
        endpoint,
        res.status,
      );
    }
    if (res.status >= 400) {
      const f = foutUitBody(raw);
      const wat = [f.code, f.param ? `veld ${f.param}` : undefined].filter(Boolean).join(', ');
      throw new StripeVerzoekFout(
        `Stripe weigerde het verzoek (HTTP ${res.status}${wat ? `, ${wat}` : ''}) op ${endpoint}${
          f.message ? `: ${f.message}` : ''
        }. Controleer de instellingen in het Stripe-dashboard (prijs, klant, Customer Portal).`,
        endpoint,
        res.status,
        f.code,
      );
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new StripeFout('onverwacht', `Stripe gaf geen geldige JSON terug op ${endpoint}.`, endpoint, res.status);
    }
  }

  function vereisUrl(s: Partial<StripeSessie>, endpoint: string): StripeSessie {
    if (typeof s.id !== 'string' || typeof s.url !== 'string' || !s.url) {
      throw new StripeFout('onverwacht', `Stripe gaf geen sessie-URL terug op ${endpoint}.`, endpoint);
    }
    return { id: s.id, url: s.url };
  }

  return {
    async maakKlant(a) {
      return await verzoek<StripeKlant>('POST', '/v1/customers', {
        name: a.naam,
        email: a.email,
        metadata: { client_id: a.clientId },
      });
    },

    async haalKlant(customerId) {
      try {
        const k = await verzoek<StripeKlant>('GET', `/v1/customers/${encodeURIComponent(customerId)}`);
        return k.deleted ? null : k;
      } catch (err) {
        if (err instanceof StripeVerzoekFout && (err.status === 404 || err.code === 'resource_missing')) {
          return null;
        }
        throw err;
      }
    },

    async maakCheckoutSessie(a) {
      const sessie = await verzoek<Partial<StripeSessie>>('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        customer: a.customerId,
        client_reference_id: a.clientId,
        line_items: [{ price: a.priceId, quantity: a.aantal }],
        subscription_data: {
          trial_period_days: a.proefperiodeDagen > 0 ? a.proefperiodeDagen : undefined,
          metadata: { client_id: a.clientId },
        },
        metadata: { client_id: a.clientId },
        success_url: a.successUrl,
        cancel_url: a.cancelUrl,
      });
      return vereisUrl(sessie, 'POST /v1/checkout/sessions');
    },

    async maakPortaalSessie(a) {
      const sessie = await verzoek<Partial<StripeSessie>>('POST', '/v1/billing_portal/sessions', {
        customer: a.customerId,
        return_url: a.returnUrl,
      });
      return vereisUrl(sessie, 'POST /v1/billing_portal/sessions');
    },

    async haalAbonnement(subscriptionId) {
      return await verzoek<StripeAbonnement>('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
  };
}
