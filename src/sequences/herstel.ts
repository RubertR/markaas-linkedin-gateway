import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';

import { maakStapActie, stopSequentieNaAfwijzing, vindSequentie } from './motor.ts';
import { teltDoorWerkdagen, type WerkdagenKiezer } from './wachttijd.ts';

/**
 * Eenmalig herstel van data van vóór SPEC §8a "afwijzen stopt de sequentie":
 * sequenties die nog 'lopend'/'geaccepteerd' staan terwijl een stap al is
 * afgewezen. Zonder `uitvoeren` alleen een plan (dry-run).
 */

export interface HerstelRegel {
  sequentieId: string;
  /** Stap van de afgewezen actie (1 = invite, 2 = bericht, 3 = opvolging). */
  stap: number | null;
  stopReden: string;
  uitgevoerd: boolean;
}

export async function herstelAfgewezenSequenties(
  db: Backend,
  limieten: Limieten,
  opties: { uitvoeren: boolean },
): Promise<HerstelRegel[]> {
  // Per sequentie de laatst afgewezen stap. Sequenties op 'reactie' vallen
  // erbuiten: daar zijn de stappen door de reactie afgewezen.
  const kandidaten = await db.query<{
    sequentie_id: string;
    actie_id: string;
    sequence_stap: number | null;
    reden: string | null;
  }>(
    `select distinct on (s.id)
            s.id as sequentie_id, a.id as actie_id, a.sequence_stap, a.reden
     from sequences s
     join actions a on a.sequence_id = s.id and a.status = 'rejected'
     where s.status in ('lopend', 'geaccepteerd')
     order by s.id, a.aangemaakt_op desc`,
  );

  const regels: HerstelRegel[] = [];
  for (const k of kandidaten) {
    const reden = k.reden?.trim() || 'geen reden vastgelegd';
    let uitgevoerd = false;
    if (opties.uitvoeren) {
      uitgevoerd = await db.transaction(async (tx) => {
        const id = await stopSequentieNaAfwijzing(tx, limieten, { actieId: k.actie_id, reden });
        return id !== null;
      });
    }
    regels.push({
      sequentieId: k.sequentie_id,
      stap: k.sequence_stap,
      stopReden: `${limieten.sequenties.stop_redenen.afgewezen}: ${reden}`,
      uitgevoerd,
    });
  }
  return regels;
}

export interface BerichtHerstelRegel {
  sequentieId: string;
  misluktActieId: string;
  /** Id van de nieuwe draft; `null` bij een dry-run of als er niets is aangemaakt. */
  nieuweActieId: string | null;
  uitgevoerd: boolean;
}

/**
 * Herstel na de 404 "Chat not found": eerste berichten (stap 2) die naar een
 * placeholder-gesprek `pending:…` gingen en daardoor mislukten. Per sequentie
 * komt er een nieuwe `draft` voor stap 2 (met providerId; de worker start dan
 * een nieuw gesprek). Die draft moet Rubert gewoon goedkeuren: dit herstel
 * zet nooit iets op `approved` (CLAUDE.md regel 1). Zonder `uitvoeren` alleen
 * een plan (dry-run). Idempotent: een sequentie met een open of verstuurde
 * stap-2-actie wordt overgeslagen.
 */
export async function herstelMislukteEersteBerichten(
  db: Backend,
  ctx: { klok: Klok; limieten: Limieten; werkdagen: WerkdagenKiezer },
  opties: { uitvoeren: boolean },
): Promise<BerichtHerstelRegel[]> {
  const kandidaten = await db.query<{ sequentie_id: string; actie_id: string; tijdzone: string }>(
    `select distinct on (s.id) s.id as sequentie_id, a.id as actie_id, acc.tijdzone
     from sequences s
     join accounts acc on acc.id = s.account_id
     join actions a on a.sequence_id = s.id and a.sequence_stap = 2
     where s.status = 'geaccepteerd'
       and s.stap = 2
       and a.status = 'failed'
       and a.payload ->> 'chatId' like 'pending:%'
       and not exists (
         select 1 from actions b
         where b.sequence_id = s.id and b.sequence_stap = 2 and b.status <> 'failed'
       )
     order by s.id, a.aangemaakt_op desc`,
  );

  const regels: BerichtHerstelRegel[] = [];
  for (const k of kandidaten) {
    let nieuweActieId: string | null = null;
    if (opties.uitvoeren) {
      const sequentie = await vindSequentie(db, k.sequentie_id);
      if (sequentie) {
        const actie = await maakStapActie(db, sequentie, 2, { naMislukking: true });
        if (actie) {
          nieuweActieId = actie.id;
          // Opvolging (stap 3) rekent vanaf nu, niet vanaf de mislukte poging.
          const bereik = ctx.limieten.sequenties.wachttijden_werkdagen.opvolging_na_eerste_bericht;
          const volgend = teltDoorWerkdagen(ctx.klok.nu(), ctx.werkdagen.kies(bereik), k.tijdzone);
          await db.query(`update sequences set volgende_actie_op = $2 where id = $1`, [
            sequentie.id,
            volgend.toISOString(),
          ]);
        }
      }
    }
    regels.push({
      sequentieId: k.sequentie_id,
      misluktActieId: k.actie_id,
      nieuweActieId,
      uitgevoerd: nieuweActieId !== null,
    });
  }
  return regels;
}
