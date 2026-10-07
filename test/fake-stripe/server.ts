import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

/**
 * Kleine nep-Stripe voor tests (SPEC §14.4), naar het voorbeeld van
 * test/fake-unipile/. Bootst de endpoints na die src/stripe/client.ts gebruikt,
 * met de vormen van de echte Stripe-API:
 *
 * - POST /v1/customers                → customer (`cus_…`) met metadata
 * - GET  /v1/customers/:id            → customer, 404 resource_missing als onbekend
 * - POST /v1/checkout/sessions        → checkout.session (`cs_test_…`) met url
 * - POST /v1/billing_portal/sessions  → billing_portal.session (`bps_…`) met url
 * - GET  /v1/subscriptions/:id        → subscription uit `abonnementen`
 *
 * Elke aanroep wordt vastgelegd (`aanroepen`) met de form-velden als platte
 * sleutels (`line_items[0][price]`). Met `storing()` geeft een endpoint een
 * vaste status/body terug (fouttests); `vertraging` vertraagt elk antwoord.
 */

export interface StripeAanroep {
  method: string;
  path: string;
  headers: Record<string, string>;
  velden: Record<string, string>;
}

export interface FakeStripeStoring {
  status: number;
  body?: unknown;
  delayMs?: number;
}

export interface FakeStripe {
  baseUrl: string;
  aanroepen: StripeAanroep[];
  klanten: Map<string, Record<string, unknown>>;
  abonnementen: Map<string, Record<string, unknown>>;
  /** Laat `METHOD pad` (exact of regex op het pad) een vaste storing geven. */
  storing(method: string, pad: string | RegExp, storing: FakeStripeStoring): void;
  reset(): void;
  stop(): Promise<void>;
}

export const FAKE_CHECKOUT_URL = 'https://checkout.stripe.test/c/pay/';
export const FAKE_PORTAAL_URL = 'https://billing.stripe.test/p/session/';

export async function startFakeStripe(): Promise<FakeStripe> {
  const aanroepen: StripeAanroep[] = [];
  const klanten = new Map<string, Record<string, unknown>>();
  const abonnementen = new Map<string, Record<string, unknown>>();
  const storingen: Array<{ method: string; pad: string | RegExp; storing: FakeStripeStoring }> = [];
  let teller = 0;
  const volgend = (prefix: string) => `${prefix}${String(++teller).padStart(6, '0')}`;

  const app = new Hono();

  app.use('*', async (c, next) => {
    const raw = await c.req.raw.clone().text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((w, k) => {
      headers[k.toLowerCase()] = w;
    });
    aanroepen.push({
      method: c.req.method,
      path: c.req.path,
      headers,
      velden: Object.fromEntries(new URLSearchParams(raw)),
    });
    if (headers['authorization'] !== undefined && !/^Bearer sk_/.test(headers['authorization'])) {
      return c.json({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, 401);
    }
    const s = storingen.find(
      (x) =>
        x.method.toUpperCase() === c.req.method &&
        (x.pad instanceof RegExp ? x.pad.test(c.req.path) : x.pad === c.req.path),
    );
    if (s) {
      if (s.storing.delayMs) await new Promise((r) => setTimeout(r, s.storing.delayMs));
      return c.json((s.storing.body ?? {}) as never, s.storing.status as never);
    }
    return await next();
  });

  const formVan = (c: { req: { raw: Request } }) =>
    c.req.raw.clone().text().then((t) => Object.fromEntries(new URLSearchParams(t)));

  const metadataUit = (v: Record<string, string>, prefix = 'metadata'): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const [k, w] of Object.entries(v)) {
      const r = new RegExp(`^${prefix.replace(/[[\]]/g, '\\$&')}\\[([^\\]]+)\\]$`).exec(k);
      if (r) m[r[1]!] = w;
    }
    return m;
  };

  const ontbreekt = (soort: string, id: string) => ({
    error: {
      type: 'invalid_request_error',
      code: 'resource_missing',
      param: 'id',
      message: `No such ${soort}: '${id}'`,
    },
  });

  app.post('/v1/customers', async (c) => {
    const v = await formVan(c);
    const id = volgend('cus_test');
    const klant = {
      id,
      object: 'customer',
      name: v['name'] ?? null,
      email: v['email'] ?? null,
      metadata: metadataUit(v),
      created: Math.floor(Date.now() / 1000),
    };
    klanten.set(id, klant);
    return c.json(klant);
  });

  app.get('/v1/customers/:id', (c) => {
    const k = klanten.get(c.req.param('id'));
    if (!k) return c.json(ontbreekt('customer', c.req.param('id')), 404);
    return c.json(k);
  });

  app.post('/v1/checkout/sessions', async (c) => {
    const v = await formVan(c);
    if (v['mode'] !== 'subscription' || !v['line_items[0][price]']) {
      return c.json(
        { error: { type: 'invalid_request_error', code: 'parameter_missing', param: 'line_items', message: 'Missing required param: line_items.' } },
        400,
      );
    }
    if (v['customer'] && !klanten.has(v['customer'])) {
      return c.json(ontbreekt('customer', v['customer']), 400);
    }
    const id = volgend('cs_test_');
    return c.json({
      id,
      object: 'checkout.session',
      mode: 'subscription',
      customer: v['customer'] ?? null,
      client_reference_id: v['client_reference_id'] ?? null,
      metadata: metadataUit(v),
      success_url: v['success_url'],
      cancel_url: v['cancel_url'],
      status: 'open',
      url: `${FAKE_CHECKOUT_URL}${id}`,
    });
  });

  app.post('/v1/billing_portal/sessions', async (c) => {
    const v = await formVan(c);
    const klant = v['customer'];
    if (!klant || !klanten.has(klant)) return c.json(ontbreekt('customer', klant ?? ''), 400);
    const id = volgend('bps_test');
    return c.json({
      id,
      object: 'billing_portal.session',
      customer: klant,
      return_url: v['return_url'],
      url: `${FAKE_PORTAAL_URL}${id}`,
    });
  });

  app.get('/v1/subscriptions/:id', (c) => {
    const s = abonnementen.get(c.req.param('id'));
    if (!s) return c.json(ontbreekt('subscription', c.req.param('id')), 404);
    return c.json(s);
  });

  app.all('*', (c) =>
    c.json({ error: { type: 'invalid_request_error', message: `Unrecognized request URL (${c.req.method}: ${c.req.path}).` } }, 404),
  );

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    aanroepen,
    klanten,
    abonnementen,
    storing(method, pad, storing) {
      storingen.push({ method, pad, storing });
    },
    reset() {
      aanroepen.length = 0;
      klanten.clear();
      abonnementen.clear();
      storingen.length = 0;
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
