import type { Backend } from '../db/backend.ts';

/**
 * Verhoogt `accounts.openstaande_verzoeken` met 1 voor een verstuurde invite
 * (SPEC §5a). Aanroepen in dezelfde transactie als de statusovergang naar
 * `done` of `onzeker`.
 *
 * Eén keer per actie: een gateway-event `invite_openstaand:<actie-id>` (uniek
 * `extern_id`) ontdubbelt. Zo telt onzeker → done (handmatig) of onzeker →
 * opnieuw goedgekeurd → done maar één keer. Geeft `true` als de teller is
 * verhoogd.
 *
 * Gebruikt `on conflict do nothing` in plaats van een gevangen unique-fout:
 * binnen een Postgres-transactie breekt een fout de hele transactie af.
 */
export async function telInviteAlsOpenstaand(
  db: Backend,
  actie: { id: string; accountId: string },
): Promise<boolean> {
  const nieuw = await db.query<{ id: string }>(
    `insert into events(bron, type, extern_id, account_id, payload)
     values ('gateway', 'invite_openstaand', $1, $2, $3::jsonb)
     on conflict (bron, extern_id) where extern_id is not null do nothing
     returning id`,
    [
      `invite_openstaand:${actie.id}`,
      actie.accountId,
      JSON.stringify({ actie_id: actie.id }),
    ],
  );
  if (nieuw.length === 0) return false;
  await db.query(
    `update accounts set openstaande_verzoeken = openstaande_verzoeken + 1 where id = $1`,
    [actie.accountId],
  );
  return true;
}
