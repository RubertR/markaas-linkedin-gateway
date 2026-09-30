export type AccountStatus =
  | 'OK'
  | 'CONNECTING'
  | 'CREDENTIALS'
  | 'ERROR'
  | 'STOPPED'
  | 'RECONNECTED'
  | 'PERMISSIONS'
  | 'UNKNOWN';

const BEKEND: Record<string, AccountStatus> = {
  ok: 'OK',
  connecting: 'CONNECTING',
  credentials: 'CREDENTIALS',
  error: 'ERROR',
  stopped: 'STOPPED',
  reconnected: 'RECONNECTED',
  permissions: 'PERMISSIONS',
  unknown: 'UNKNOWN',
};

export function mapUnipileStatus(waarde: unknown): AccountStatus {
  if (typeof waarde !== 'string') return 'UNKNOWN';
  return BEKEND[waarde.toLowerCase()] ?? 'UNKNOWN';
}
