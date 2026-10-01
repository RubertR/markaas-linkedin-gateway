import type { Klok } from '../budget/klok.ts';
import type { ActieType, Limieten, PauzeGrensSeconden } from '../budget/limits.ts';
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
 *
 * Pauze per actietype — SPEC §7, config `pauze_mcp_sync_seconden`:
 * profielen vragen 30–90 s pauze, zoekopdrachten 2–8 min. De pauze gaat uit
 * van de laatste **uitgevoerde** actie van ditzelfde type op ditzelfde
 * account. Is de minimale pauze nog niet verstreken, dan antwoordt deze
 * helper direct met "probeer opnieuw over N seconden" — zonder actie aan te
 * maken en zonder Unipile aan te roepen.
 */

export type McpSyncOorzaak = 'wachtrij' | 'weigering' | 'fout';

export class McpSynchroonFout extends Error {
  readonly oorzaak: McpSyncOorzaak;
  readonly actieId: string | null;
  readonly structureel: boolean;
  readonly resterendSeconden: number | null;

  constructor(
    oorzaak: McpSyncOorzaak,
    bericht: string,
    actieId: string | null,
    structureel: boolean,
    resterendSeconden: number | null = null,
  ) {
    super(bericht);
    this.name = 'McpSynchroonFout';
    this.oorzaak = oorzaak;
    this.actieId = actieId;
    this.structureel = structureel;
    this.resterendSeconden = resterendSeconden;
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
  const grens = kiesPauzeGrens(ctx.limieten, invoer.type);
  const minPauzeSeconden = ctx.pauzeKiezer.kiesSeconden(grens);

  const laatsteActieOp = await laatsteUitgevoerdOpVoorType(
    ctx.db,
    invoer.accountId,
    invoer.type,
  );
  if (laatsteActieOp) {
    const nu = ctx.klok.nu();
    const sinds = Math.floor((nu.getTime() - laatsteActieOp.getTime()) / 1000);
    if (sinds < minPauzeSeconden) {
      const resterend = Math.max(1, minPauzeSeconden - sinds);
      throw new McpSynchroonFout(
        'wachtrij',
        `Vorige ${invoer.type}-actie op dit account was ${sinds} seconden geleden; minimale pauze is ${minPauzeSeconden} seconden. Probeer opnieuw over ${resterend} seconden.`,
        null,
        false,
        resterend,
      );
    }
  }

  const actie = await maakActie(ctx.db, {
    accountId: invoer.accountId,
    type: invoer.type,
    payload: invoer.payload,
    directApproved: true,
  });

  // Pauze is al in deze helper afgedwongen; de budgetmotor hoeft hem niet
  // nog eens te checken (anders zouden profiel-actietypes alsnog tegen de
  // generieke 2–8 min pauze aanlopen).
  const beoordeling = await reserveerEnVerbruik(ctx.db, {
    accountId: actie.accountId,
    actieType: actie.type,
    goedgekeurd: true,
    klok: ctx.klok,
    limieten: ctx.limieten,
    minPauzeSeconden: 0,
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

function kiesPauzeGrens(limieten: Limieten, type: 'search' | 'profile'): PauzeGrensSeconden {
  return limieten.tijdvenster.pauze_mcp_sync_seconden[type];
}

async function laatsteUitgevoerdOpVoorType(
  db: Backend,
  accountId: string,
  type: 'search' | 'profile',
): Promise<Date | null> {
  const rijen = await db.query<{ uitgevoerd_op: string | Date | null }>(
    `select max(uitgevoerd_op) as uitgevoerd_op from actions
     where account_id = $1 and type = $2::action_type and uitgevoerd_op is not null`,
    [accountId, type],
  );
  const w = rijen[0]?.uitgevoerd_op;
  if (!w) return null;
  return w instanceof Date ? w : new Date(w);
}
