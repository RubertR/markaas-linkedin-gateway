import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

export interface Scenario {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface OpgevangenAanroep {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

type ScenarioBron = Scenario | (() => Scenario | Promise<Scenario>);

interface Handler {
  method: string;
  pad: string | RegExp;
  scenario: ScenarioBron;
}

export interface FakeUnipile {
  baseUrl: string;
  aanroepen: OpgevangenAanroep[];
  antwoord(method: string, pad: string | RegExp, scenario: ScenarioBron): void;
  reset(): void;
  stop(): Promise<void>;
}

function padMatcht(pad: string | RegExp, aanvraagPad: string): boolean {
  if (pad instanceof RegExp) return pad.test(aanvraagPad);
  const zonderQuery = aanvraagPad.split('?')[0] ?? aanvraagPad;
  return pad === aanvraagPad || pad === zonderQuery;
}

export async function startFakeUnipile(): Promise<FakeUnipile> {
  const handlers: Handler[] = [];
  const aanroepen: OpgevangenAanroep[] = [];

  const app = new Hono();

  app.all('*', async (c) => {
    const raw = await c.req.raw.clone().text();
    const contentType = c.req.header('content-type') ?? '';
    let body: unknown = undefined;
    if (contentType.startsWith('application/json') && raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (contentType.startsWith('multipart/form-data')) {
      try {
        const parsed = await c.req.parseBody({ all: true });
        body = parsed;
      } catch {
        body = raw;
      }
    } else if (raw) {
      body = raw;
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((waarde, sleutel) => {
      headers[sleutel.toLowerCase()] = waarde;
    });

    aanroepen.push({
      method: c.req.method,
      path: c.req.path + (c.req.raw.url.includes('?') ? '?' + c.req.raw.url.split('?').slice(1).join('?') : ''),
      headers,
      body,
      raw,
    });

    const handler = handlers.find(
      (h) => h.method.toUpperCase() === c.req.method && padMatcht(h.pad, c.req.path),
    );
    if (!handler) {
      return c.json(
        { error: 'geen_fake_handler', method: c.req.method, path: c.req.path },
        404,
      );
    }

    const scenario = await Promise.resolve(
      typeof handler.scenario === 'function' ? handler.scenario() : handler.scenario,
    );

    if (scenario.delayMs && scenario.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
    }

    for (const [k, v] of Object.entries(scenario.headers ?? {})) {
      c.header(k, v);
    }

    if (scenario.body === undefined || scenario.body === null) {
      return c.body(null, scenario.status as never);
    }
    if (typeof scenario.body === 'string') {
      return c.body(scenario.body, scenario.status as never);
    }
    return c.json(scenario.body as never, scenario.status as never);
  });

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => {
      resolve(s);
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    aanroepen,
    antwoord(method, pad, scenario) {
      handlers.push({ method, pad, scenario });
    },
    reset() {
      handlers.length = 0;
      aanroepen.length = 0;
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
