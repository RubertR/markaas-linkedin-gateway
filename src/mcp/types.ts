export const JSONRPC_VERSION = '2.0' as const;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export const RPC_FOUT = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export function rpcSucces(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcFout(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcError['error'] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError: boolean;
}

export function toolSucces(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

export function toolFout(bericht: string): ToolResult {
  return {
    content: [{ type: 'text', text: bericht }],
    isError: true,
  };
}
