import type { Backend } from '../db/backend.ts';

export interface Client {
  id: string;
  naam: string;
  slug: string;
  actief: boolean;
  aangemaaktOp: Date;
}

export interface MaakClientInvoer {
  naam: string;
  slug: string;
}

interface ClientRij {
  id: string;
  naam: string;
  slug: string;
  actief: boolean;
  aangemaakt_op: string | Date;
}

function map(rij: ClientRij): Client {
  return {
    id: rij.id,
    naam: rij.naam,
    slug: rij.slug,
    actief: rij.actief,
    aangemaaktOp: rij.aangemaakt_op instanceof Date ? rij.aangemaakt_op : new Date(rij.aangemaakt_op),
  };
}

export async function maakClient(db: Backend, invoer: MaakClientInvoer): Promise<Client> {
  try {
    const rijen = await db.query<ClientRij>(
      `insert into clients(naam, slug)
       values ($1, $2)
       returning id, naam, slug, actief, aangemaakt_op`,
      [invoer.naam, invoer.slug],
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
    `select id, naam, slug, actief, aangemaakt_op from clients where slug = $1`,
    [slug],
  );
  return rijen[0] ? map(rijen[0]) : null;
}

function isUniekeSchendingVoor(err: unknown, veld: string): boolean {
  const bericht = (err as Error)?.message ?? '';
  return /duplicate|unique/i.test(bericht) && bericht.includes(veld);
}
