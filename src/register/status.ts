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

/**
 * Hoe streng een storingsstatus is (SPEC §6a regel 5): `STOPPED` > `ERROR` >
 * `CREDENTIALS`. Alle andere statussen tellen als 0. Komen gateway en webhook
 * met verschillende storingen binnen, dan wint de strengste.
 */
export function statusStrengte(status: AccountStatus): number {
  switch (status) {
    case 'STOPPED':
      return 3;
    case 'ERROR':
      return 2;
    case 'CREDENTIALS':
      return 1;
    default:
      return 0;
  }
}
