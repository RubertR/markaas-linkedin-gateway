import type { Klok } from '../budget/klok.ts';
import { lokaleDag } from '../budget/tijdvenster.ts';
import type { Backend } from '../db/backend.ts';
import type { AccountStatus } from '../register/status.ts';

/**
 * Resultaten voor het klantportaal (SPEC §14.3): per account van de eigen
 * klant de stand van het account en per week (laatste 8 weken, maandag tot
 * en met zondag in Europe/Amsterdam) de aantallen:
 *
 * - **verzoeken**: invites met status `done` of `onzeker` (zelfde regel als
 *   `openstaande_verzoeken`, §5a: onzeker kan verstuurd zijn), op `uitgevoerd_op`;
 * - **acceptaties**: gateway-events `acceptatie` (één per account+lead, §8a.3);
 * - **reacties**: gesprekken (unieke `chat_id`) met een `message_received` van
 *   de lead in die week. Eigen berichten (`message_sent_self`) tellen niet.
 *
 * Elke query filtert via `accounts.client_id` op de klant van de gebruiker.
 */

export const RESULTATEN_WEKEN = 8;
const WEERGAVE_TIJDZONE = 'Europe/Amsterdam';

export type AccountStand =
  | 'gekoppeld'
  | 'niet_gekoppeld'
  | 'opnieuw_koppelen'
  | 'afkoeling'
  | 'opbouw'
  | 'storing';

export interface WeekCijfers {
  /** Maandag van de week, `YYYY-MM-DD`. */
  weekStart: string;
  verzoeken: number;
  acceptaties: number;
  reacties: number;
}

export interface AccountResultaat {
  accountId: string;
  eigenaarNaam: string;
  status: AccountStatus;
  stand: AccountStand;
  afkoelingTot: Date | null;
  opbouwPercentage: number;
  /** Oudste week eerst. */
  weken: WeekCijfers[];
  totaal: { verzoeken: number; acceptaties: number; reacties: number };
}

export interface StandInvoer {
  gekoppeld: boolean;
  status: AccountStatus;
  afkoelingTot: Date | null;
  opbouwFactor: number;
}

export function bepaalStand(a: StandInvoer, nu: Date): AccountStand {
  if (!a.gekoppeld) return 'niet_gekoppeld';
  if (a.status === 'CREDENTIALS') return 'opnieuw_koppelen';
  if (a.status !== 'OK' && a.status !== 'RECONNECTED') return 'storing';
  if (a.afkoelingTot && a.afkoelingTot.getTime() > nu.getTime()) return 'afkoeling';
  if (a.opbouwFactor < 1) return 'opbouw';
  return 'gekoppeld';
}

/** Mag de klant via het portaal een (her)koppellink maken? */
export function kanOpnieuwKoppelen(stand: AccountStand): boolean {
  return stand === 'niet_gekoppeld' || stand === 'opnieuw_koppelen';
}

/** De maandagen van de laatste `aantal` weken, oudste eerst. */
export function weekStarts(nu: Date, tijdzone: string, aantal: number): string[] {
  const vandaag = lokaleDag(nu, tijdzone); // YYYY-MM-DD
  const d = new Date(`${vandaag}T00:00:00Z`);
  const weekdag = (d.getUTCDay() + 6) % 7; // maandag = 0
  d.setUTCDate(d.getUTCDate() - weekdag);
  const uit: string[] = [];
  for (let i = aantal - 1; i >= 0; i--) {
    const w = new Date(d.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    uit.push(w.toISOString().slice(0, 10));
  }
  return uit;
}

interface AccountRij {
  id: string;
  eigenaar_naam: string;
  unipile_account_id: string | null;
  status: AccountStatus;
  afkoeling_tot: string | Date | null;
  opbouw_factor: string | number;
}

interface TelRij {
  account_id: string;
  week: string;
  aantal: number;
}

export async function accountsVanKlant(db: Backend, clientId: string): Promise<AccountRij[]> {
  return await db.query<AccountRij>(
    `select id, eigenaar_naam, unipile_account_id, status::text as status, afkoeling_tot, opbouw_factor
     from accounts where client_id = $1
     order by aangemaakt_op, id`,
    [clientId],
  );
}

export async function resultatenVoorKlant(
  db: Backend,
  clientId: string,
  klok: Klok,
): Promise<AccountResultaat[]> {
  const nu = klok.nu();
  const weken = weekStarts(nu, WEERGAVE_TIJDZONE, RESULTATEN_WEKEN);
  const vanaf = weken[0]!;
  const accounts = await accountsVanKlant(db, clientId);
  const params = [clientId, WEERGAVE_TIJDZONE, vanaf];
  const week = (kolom: string) =>
    `to_char(date_trunc('week', ${kolom} at time zone $2), 'YYYY-MM-DD')`;

  const verzoeken = await db.query<TelRij>(
    `select a.account_id, ${week('a.uitgevoerd_op')} as week, count(*)::int as aantal
     from actions a join accounts acc on acc.id = a.account_id
     where acc.client_id = $1
       and a.type = 'invite'
       and a.status in ('done', 'onzeker')
       and a.uitgevoerd_op is not null
       and (a.uitgevoerd_op at time zone $2)::date >= $3::date
     group by 1, 2`,
    params,
  );
  const acceptaties = await db.query<TelRij>(
    `select e.account_id, ${week('e.ontvangen_op')} as week, count(*)::int as aantal
     from events e join accounts acc on acc.id = e.account_id
     where acc.client_id = $1
       and e.type = 'acceptatie'
       and (e.ontvangen_op at time zone $2)::date >= $3::date
     group by 1, 2`,
    params,
  );
  const reacties = await db.query<TelRij>(
    `select e.account_id, ${week('e.ontvangen_op')} as week,
            count(distinct coalesce(e.payload ->> 'chat_id', e.id::text))::int as aantal
     from events e join accounts acc on acc.id = e.account_id
     where acc.client_id = $1
       and e.type = 'message_received'
       and (e.ontvangen_op at time zone $2)::date >= $3::date
     group by 1, 2`,
    params,
  );

  const sleutel = (accountId: string, w: string) => `${accountId}|${w}`;
  const tabel = (rijen: TelRij[]) => new Map(rijen.map((r) => [sleutel(r.account_id, r.week), Number(r.aantal)]));
  const v = tabel(verzoeken);
  const a = tabel(acceptaties);
  const r = tabel(reacties);

  return accounts.map((acc) => {
    const afkoelingTot =
      acc.afkoeling_tot === null
        ? null
        : acc.afkoeling_tot instanceof Date
          ? acc.afkoeling_tot
          : new Date(acc.afkoeling_tot);
    const opbouwFactor = Number(acc.opbouw_factor);
    const perWeek = weken.map((w) => ({
      weekStart: w,
      verzoeken: v.get(sleutel(acc.id, w)) ?? 0,
      acceptaties: a.get(sleutel(acc.id, w)) ?? 0,
      reacties: r.get(sleutel(acc.id, w)) ?? 0,
    }));
    return {
      accountId: acc.id,
      eigenaarNaam: acc.eigenaar_naam,
      status: acc.status,
      stand: bepaalStand(
        { gekoppeld: acc.unipile_account_id !== null, status: acc.status, afkoelingTot, opbouwFactor },
        nu,
      ),
      afkoelingTot,
      opbouwPercentage: Math.round(opbouwFactor * 100),
      weken: perWeek,
      totaal: {
        verzoeken: perWeek.reduce((s, x) => s + x.verzoeken, 0),
        acceptaties: perWeek.reduce((s, x) => s + x.acceptaties, 0),
        reacties: perWeek.reduce((s, x) => s + x.reacties, 0),
      },
    };
  });
}
