import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import type { Abonnement } from '../register/accounts.ts';
import type { AccountStatus } from '../register/status.ts';

/**
 * Leeskant van `/admin/klanten` (SPEC §14.2): klanten met hun accounts en de
 * stand van de laatste koppeluitnodiging. Tokens zijn hier nooit beschikbaar
 * (alleen hashes in de database).
 */

export type UitnodigingStand = 'geen' | 'open' | 'verlopen' | 'gebruikt';

export interface AccountRegel {
  id: string;
  eigenaarNaam: string;
  eigenaarEmail: string | null;
  abonnement: Abonnement;
  status: AccountStatus;
  gekoppeld: boolean;
  uitnodiging: UitnodigingStand;
  uitnodigingVerlooptOp: Date | null;
}

export interface KlantRegel {
  id: string;
  naam: string;
  slug: string;
  abonnementVereist: boolean;
  accounts: AccountRegel[];
}

interface Rij {
  client_id: string;
  client_naam: string;
  slug: string;
  abonnement_vereist: boolean;
  account_id: string | null;
  eigenaar_naam: string | null;
  eigenaar_email: string | null;
  abonnement: Abonnement | null;
  status: AccountStatus | null;
  unipile_account_id: string | null;
  verloopt_op: string | Date | null;
  gebruikt_op: string | Date | null;
}

function alsDatum(w: string | Date | null): Date | null {
  if (w === null) return null;
  return w instanceof Date ? w : new Date(w);
}

export async function lijstKlanten(db: Backend, klok: Klok): Promise<KlantRegel[]> {
  const rijen = await db.query<Rij>(
    `select c.id as client_id, c.naam as client_naam, c.slug, c.abonnement_vereist,
            a.id as account_id, a.eigenaar_naam, a.eigenaar_email, a.abonnement, a.status,
            a.unipile_account_id, u.verloopt_op, u.gebruikt_op
     from clients c
     left join accounts a on a.client_id = c.id
     left join lateral (
       select verloopt_op, gebruikt_op from koppel_uitnodigingen
       where account_id = a.id
       order by aangemaakt_op desc, id desc
       limit 1
     ) u on true
     order by lower(c.naam), c.id, a.aangemaakt_op, a.id`,
  );
  const nu = klok.nu().getTime();
  const klanten: KlantRegel[] = [];
  const perId = new Map<string, KlantRegel>();
  for (const r of rijen) {
    let klant = perId.get(r.client_id);
    if (!klant) {
      klant = {
        id: r.client_id,
        naam: r.client_naam,
        slug: r.slug,
        abonnementVereist: r.abonnement_vereist,
        accounts: [],
      };
      perId.set(r.client_id, klant);
      klanten.push(klant);
    }
    if (!r.account_id) continue;
    const verloopt = alsDatum(r.verloopt_op);
    const gebruikt = alsDatum(r.gebruikt_op);
    let stand: UitnodigingStand = 'geen';
    if (verloopt) {
      stand = gebruikt ? 'gebruikt' : verloopt.getTime() > nu ? 'open' : 'verlopen';
    }
    klant.accounts.push({
      id: r.account_id,
      eigenaarNaam: r.eigenaar_naam ?? '',
      eigenaarEmail: r.eigenaar_email,
      abonnement: r.abonnement as Abonnement,
      status: r.status as AccountStatus,
      gekoppeld: r.unipile_account_id !== null,
      uitnodiging: stand,
      uitnodigingVerlooptOp: verloopt,
    });
  }
  return klanten;
}

/** Gegevens voor de resultaatpagina na het maken van een koppellink. */
export async function haalAccountVoorKoppellink(
  db: Backend,
  accountId: string,
): Promise<{ klantNaam: string; eigenaarNaam: string; eigenaarEmail: string | null } | null> {
  const rijen = await db.query<{ naam: string; eigenaar_naam: string; eigenaar_email: string | null }>(
    `select c.naam, a.eigenaar_naam, a.eigenaar_email
     from accounts a join clients c on c.id = a.client_id where a.id = $1`,
    [accountId],
  );
  const r = rijen[0];
  return r ? { klantNaam: r.naam, eigenaarNaam: r.eigenaar_naam, eigenaarEmail: r.eigenaar_email } : null;
}
