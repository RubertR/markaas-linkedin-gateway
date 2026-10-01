import { Hono } from 'hono';

import {
  isBekendeTool,
  McpToolInvoerFout,
  voerTool,
  type McpToolsDeps,
} from './tools.ts';
import { TOOL_DEFINITIES } from './schema.ts';
import { McpSynchroonFout } from './synchroon.ts';
import { tokenUitAuthorization, vergelijkMcpToken } from './token.ts';
import {
  rpcFout,
  rpcSucces,
  toolFout,
  toolSucces,
  RPC_FOUT,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './types.ts';

export interface McpAppDeps extends McpToolsDeps {
  mcpToken: string;
}

/**
 * Streamable-HTTP MCP-server (SPEC §7, §12). Luistert op POST `/mcp` en
 * verwerkt JSON-RPC-berichten (initialize, tools/list, tools/call, ping,
 * notifications/initialized). Elke aanvraag vereist een geldige bearer-token
 * uit `MCP_TOKEN`; vergelijking is constante tijd.
 *
 * Server-initiated SSE via GET is bewust niet geïmplementeerd: deze gateway
 * stuurt geen notificaties richting de skill.
 */

const PROTOCOL_VERSIE = '2024-11-05';
const WEIGER_TEKST =
  'Onbevoegd: ongeldige of ontbrekende MCP-bearer-token. Geef een geldige Authorization: Bearer <token> mee.';
const SERVER_INFO = {
  name: 'markaas-linkedin-gateway',
  version: '0.1.0',
} as const;

export function maakMcpApp(deps: McpAppDeps) {
  const app = new Hono();

  app.use('/mcp', async (c, next) => {
    const token = tokenUitAuthorization(c.req.header('authorization'));
    if (!vergelijkMcpToken(token, deps.mcpToken)) {
      return c.text(WEIGER_TEKST, 401);
    }
    return await next();
  });

  app.get('/mcp', (c) =>
    c.text(
      'MCP Streamable HTTP: GET-SSE wordt door deze gateway niet aangeboden. Gebruik POST /mcp met een JSON-RPC-bericht.',
      405,
    ),
  );

  app.post('/mcp', async (c) => {
    let bericht: unknown;
    try {
      bericht = await c.req.json();
    } catch {
      return c.json(
        rpcFout(null, RPC_FOUT.parse, 'Ongeldige JSON in verzoek-body.'),
        400,
      );
    }
    const antwoord = await verwerkBericht(deps, bericht);
    if (antwoord === undefined) {
      // Notificatie zonder id — MCP vraagt om een lege 202-respons.
      return c.body(null, 202);
    }
    return c.json(antwoord);
  });

  return app;
}

export async function verwerkBericht(
  deps: McpAppDeps,
  bericht: unknown,
): Promise<JsonRpcResponse | undefined> {
  if (!isGeldigeRpcRequest(bericht)) {
    return rpcFout(null, RPC_FOUT.invalidRequest, 'Verzoek is geen geldig JSON-RPC-2.0-bericht.');
  }
  const id = bericht.id ?? null;
  const isNotificatie = bericht.id === undefined;

  try {
    switch (bericht.method) {
      case 'initialize':
        return rpcSucces(id, {
          protocolVersion: PROTOCOL_VERSIE,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case 'tools/list':
        return rpcSucces(id, { tools: TOOL_DEFINITIES });

      case 'tools/call': {
        const params = bericht.params;
        if (!isObject(params) || typeof params['name'] !== 'string') {
          return rpcFout(
            id,
            RPC_FOUT.invalidParams,
            'tools/call vereist een params-object met minimaal "name" (tekst).',
          );
        }
        const naam = params['name'];
        if (!isBekendeTool(naam)) {
          return rpcSucces(
            id,
            toolFout(
              `Onbekende tool "${naam}". Beschikbaar: ${TOOL_DEFINITIES.map((t) => t.name).join(', ')}.`,
            ),
          );
        }
        const args = isObject(params['arguments']) ? params['arguments'] : {};
        try {
          const data = await voerTool(deps, naam, args);
          return rpcSucces(id, toolSucces(data));
        } catch (err) {
          return rpcSucces(id, toolFout(foutnaarNl(err)));
        }
      }

      case 'ping':
        return rpcSucces(id, {});

      case 'notifications/initialized':
      case 'notifications/cancelled':
        // Notificaties: geen antwoord.
        return undefined;

      default:
        if (isNotificatie) return undefined;
        return rpcFout(
          id,
          RPC_FOUT.methodNotFound,
          `Methode "${bericht.method}" is niet beschikbaar in deze MCP-server.`,
        );
    }
  } catch (err) {
    if (isNotificatie) return undefined;
    return rpcFout(
      id,
      RPC_FOUT.internal,
      `Interne fout tijdens verwerken: ${(err as Error).message}`,
    );
  }
}

function isGeldigeRpcRequest(waarde: unknown): waarde is JsonRpcRequest {
  if (!isObject(waarde)) return false;
  if (waarde['jsonrpc'] !== '2.0') return false;
  if (typeof waarde['method'] !== 'string' || waarde['method'] === '') return false;
  const id = waarde['id'];
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return false;
  }
  return true;
}

function isObject(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}

function foutnaarNl(err: unknown): string {
  if (err instanceof McpSynchroonFout) return err.message;
  if (err instanceof McpToolInvoerFout) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
