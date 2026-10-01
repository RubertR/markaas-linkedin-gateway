export interface Backend {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  /**
   * Voert `fn` uit binnen een database-transactie. De doorgegeven Backend
   * routeert zijn queries door de transactie; nested transacties zijn niet
   * ondersteund. Gebruikt voor atomic reservering en verbruik van budget
   * (SPEC §5): twee acties die tegelijk aankomen mogen samen nooit over de
   * grens heen.
   */
  transaction<T>(fn: (db: Backend) => Promise<T>): Promise<T>;
}
