import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';

import { stopSequentieNaAfwijzing } from './motor.ts';

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
