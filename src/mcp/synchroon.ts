import type { Klok } from '../budget/klok.ts';
import type { ActieType, Limieten } from '../budget/limits.ts';
import { reserveerEnVerbruik } from '../budget/verbruik.ts';
import type { Backend } from '../db/backend.ts';
import {
  maakActie,
  zetActieStatus,
  type Actie,
} from '../queue/acties.ts';
import type { PauzeKiezer } from '../queue/pauze.ts';
import { voerActieUit, type WorkerContext } from '../queue/worker.ts';
import type { UnipileClient } from '../unipile/client.ts';

/**
 * Draait een `search` of `profile` synchroon door hetzelfde pad als de planner:
 * actie aanmaken → budgetmotor → worker. Zo loopt de MCP-tool nooit rechtstreeks
 * naar Unipile (CLAUDE.md regel 1 en SPEC §7). Het resultaat is het Unipile-
 * antwoord dat de worker in `unipile_response` opsloeg; faalt een stap, dan
 * gooit deze helper een `McpSynchroonFout` met een NL-reden.
 */

export type McpSyncOorzaak = 'wachtrij' | 'weigering' | 'fout';

export class McpSynchroonFout extends Error {
  readonly oorzaak: McpSyncOorzaak;
  readonly actieId: string;
  readonly structureel: boolean;

  constructor(oorzaak: McpSyncOorzaak, bericht: string, actieId: string, structureel: boolean) {
    super(bericht);
    this.name = 'McpSynchroonFout';
    this.oorzaak = oorzaak;
    this.actieId = actieId;
    this.structureel = structureel;
  }
}

export interface SynchroonContext {
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  klok: Klok;
  pauzeKiezer: PauzeKiezer;
}

export interface SynchroonInvoer {
  accountId: string;
  type: Extract<ActieType, 'search' | 'profile'>;
  payload: Record<string, unknown>;
}

export interface SynchroonResultaat {
  actieId: string;
  response: Record<string, unknown>;
}

export async function voerSynchroonUit(
  ctx: SynchroonContext,
  invoer: SynchroonInvoer,
): Promise<SynchroonResultaat> {
  const actie = await maakActie(ctx.db, {
    accountId: invoer.accountId,
    type: invoer.type,
    payload: invoer.payload,
    directApproved: true,
  });

  const minPauzeSeconden = ctx.pauzeKiezer.kies(
    ctx.limieten.tijdvenster.pauze_tussen_acties_minuten,
  );
  const beoordeling = await reserveerEnVerbruik(ctx.db, {
    accountId: actie.accountId,
    actieType: actie.type,
    goedgekeurd: true,
    klok: ctx.klok,
    limieten: ctx.limieten,
    minPauzeSeconden,
    laatsteActieOp: null,
  });

  if (beoordeling.status === 'wachtrij') {
    await zetActieStatus(ctx.db, actie.id, 'queued', { reden: beoordeling.reden });
    throw new McpSynchroonFout(
      'wachtrij',
      `Niet nu beschikbaar — ${beoordeling.reden}`,
      actie.id,
      false,
    );
  }
  if (beoordeling.status === 'weigering') {
    await zetActieStatus(ctx.db, actie.id, 'rejected', { reden: beoordeling.reden });
    throw new McpSynchroonFout(
      'weigering',
      `Geweigerd — ${beoordeling.reden}`,
      actie.id,
      true,
    );
  }

  const workerCtx: WorkerContext = {
    db: ctx.db,
    unipile: ctx.unipile,
    limieten: ctx.limieten,
    klok: ctx.klok,
  };
  const uitkomst = await voerActieUit(workerCtx, actie as Actie);
  if (uitkomst.status === 'done') {
    return { actieId: actie.id, response: uitkomst.response ?? {} };
  }
  const reden =
    uitkomst.reden ?? `Uitvoeren van ${invoer.type} mislukte zonder opgegeven reden.`;
  throw new McpSynchroonFout('fout', reden, actie.id, uitkomst.status === 'failed');
}
