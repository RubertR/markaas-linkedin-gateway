import type { Backend } from '../db/backend.ts';

export interface Client {
  id: string;
  naam: string;
  slug: string;
  actief: boolean;
  /** Betaalpoort (SPEC §14.4): zonder actief abonnement geen verzending. */
  abonnementVereist: boolean;
  aangemaaktOp: Date;
}

export interface MaakClientInvoer {
  naam: string;
  slug: string;
  /** Standaard true (schemastandaard). */
  abonnementVereist?: boolean;
}

interface ClientRij {
  id: string;
  naam: string;
  slug: string;
  actief: boolean;
  abonnement_vereist: boolean;
  aangemaakt_op: string | Date;
}

const KOLOMMEN = 'id, naam, slug, actief, abonnement_vereist, aangemaakt_op';

function map(rij: ClientRij): Client {
  return {
    id: rij.id,
    naam: rij.naam,
    slug: rij.slug,
    actief: rij.actief,
    abonnementVereist: rij.abonnement_vereist,
    aangemaaktOp: rij.aangemaakt_op instanceof Date ? rij.aangemaakt_op : new Date(rij.aangemaakt_op),
  };
}

export async function maakClient(db: Backend, invoer: MaakClientInvoer): Promise<Client> {
  try {
    const rijen = await db.query<ClientRij>(
      `insert into clients(naam, slug, abonnement_vereist)
       values ($1, $2, coalesce($3::boolean, true))
       returning ${KOLOMMEN}`,
      [invoer.naam, invoer.slug, invoer.abonnementVereist ?? null],
    );
    const rij = rijen[0];
    if (!rij) throw new Error('Client aanmaken gaf geen rij terug.');
    return map(rij);
  } catch (err) {
    if (isUniekeSchendingVoor(err, 'slug')) {
      throw new Error(`Slug "${invoer.slug}" bestaat al voor een andere client.`);
    }
    throw err;
  }
}

export async function vindClientBijSlug(db: Backend, slug: string): Promise<Client | null> {
  const rijen = await db.query<ClientRij>(
    `select ${KOLOMMEN} from clients where slug = $1`,
    [slug],
  );
  return rijen[0] ? map(rijen[0]) : null;
}

function isUniekeSchendingVoor(err: unknown, veld: string): boolean {
  const bericht = (err as Error)?.message ?? '';
  return /duplicate|unique/i.test(bericht) && bericht.includes(veld);
}
