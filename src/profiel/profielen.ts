import type { Klok } from '../budget/klok.ts';
import type { Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';

import { alleenBekendeVragen, ontbrekendeVerplichte, type Antwoorden } from './invoer.ts';

/**
 * Klantprofielen (SPEC §14.6), tabel `klantprofielen`.
 *
 * Levenscyclus per klant:
 *   (geen) → concept → ingediend → vastgesteld → (wijziging aanvragen) → concept …
 *   ingediend → (terugsturen met vraag) → concept
 * Per klant hooguit één open versie (concept of ingediend) en één vastgestelde;
 * bij vaststellen wordt de vorige vastgestelde `vervangen`.
 *
 * Elke functie krijgt de client_id van de aanroeper (portaalsessie of admin);
 * er is geen functie die een profiel op id ophaalt, zodat een klant nooit bij
 * het profiel van een andere klant kan.
 */

export type ProfielStatus = 'concept' | 'ingediend' | 'vastgesteld' | 'vervangen';

export interface Klantprofiel {
  id: string;
  clientId: string;
  versie: number;
  status: ProfielStatus;
  intakeVersie: string;
  antwoorden: Antwoorden;
  interneAanvulling: string;
  vraagVanMarkaas: string | null;
  revisie: number;
  ingediendDoor: string | null;
  ingediendOp: Date | null;
  vastgesteldDoor: string | null;
  vastgesteldOp: Date | null;
  bijgewerktOp: Date;
}

export interface ProfielStand {
  /** Concept of ingediend; null als er niets openstaat. */
  open: Klantprofiel | null;
  vastgesteld: Klantprofiel | null;
}

/** Fout met een NL-tekst die letterlijk aan klant of beheerder getoond mag worden. */
export class ProfielFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'ProfielFout';
  }
}

/** Een collega heeft intussen opgeslagen: geen stille overschrijving. */
export class ProfielConflictFout extends ProfielFout {
  constructor() {
    super(
      'Een collega heeft het klantprofiel intussen bijgewerkt. Hieronder staat de nieuwste stand; controleer uw antwoorden en sla opnieuw op.',
    );
    this.name = 'ProfielConflictFout';
  }
}

export const MAX_INTERNE_AANVULLING = 10_000;
export const MAX_VRAAG = 1000;
export const MAX_ANTWOORD = 1000;

export interface ProfielBericht {
  id: string;
  van: 'markaas' | 'klant';
  tekst: string;
  door: string;
  op: Date;
}

/** Gesprek bij één profielversie, oudste eerst; altijd gefilterd op de klant. */
export async function berichtenVoorProfiel(db: Backend, clientId: string, profielId: string): Promise<ProfielBericht[]> {
  const rijen = await db.query<{ id: string; van: 'markaas' | 'klant'; tekst: string; door: string; op: string | Date }>(
    `select id, van, tekst, door, op from klantprofiel_berichten
      where client_id = $1 and profiel_id = $2
      order by nr`,
    [clientId, profielId],
  );
  return rijen.map((r) => ({ id: r.id, van: r.van, tekst: r.tekst, door: r.door, op: datum(r.op)! }));
}

async function voegBerichtToe(
  db: Backend,
  o: { profielId: string; clientId: string; van: 'markaas' | 'klant'; tekst: string; door: string; op: string },
): Promise<void> {
  await db.query(
    `insert into klantprofiel_berichten(profiel_id, client_id, van, tekst, door, op) values ($1, $2, $3, $4, $5, $6)`,
    [o.profielId, o.clientId, o.van, o.tekst, o.door, o.op],
  );
}

const KOLOMMEN = `id, client_id, versie, status, intake_versie, antwoorden, interne_aanvulling,
  vraag_van_markaas, revisie, ingediend_door, ingediend_op, vastgesteld_door, vastgesteld_op, bijgewerkt_op`;

interface ProfielRij {
  id: string;
  client_id: string;
  versie: number;
  status: ProfielStatus;
  intake_versie: string;
  antwoorden: Antwoorden | string;
  interne_aanvulling: string;
  vraag_van_markaas: string | null;
  revisie: number;
  ingediend_door: string | null;
  ingediend_op: string | Date | null;
  vastgesteld_door: string | null;
  vastgesteld_op: string | Date | null;
  bijgewerkt_op: string | Date;
}

function datum(w: string | Date | null): Date | null {
  if (w === null) return null;
  return w instanceof Date ? w : new Date(w);
}

function map(r: ProfielRij): Klantprofiel {
  return {
    id: r.id,
    clientId: r.client_id,
    versie: Number(r.versie),
    status: r.status,
    intakeVersie: r.intake_versie,
    antwoorden: typeof r.antwoorden === 'string' ? (JSON.parse(r.antwoorden) as Antwoorden) : r.antwoorden,
    interneAanvulling: r.interne_aanvulling,
    vraagVanMarkaas: r.vraag_van_markaas,
    revisie: Number(r.revisie),
    ingediendDoor: r.ingediend_door,
    ingediendOp: datum(r.ingediend_op),
    vastgesteldDoor: r.vastgesteld_door,
    vastgesteldOp: datum(r.vastgesteld_op),
    bijgewerktOp: datum(r.bijgewerkt_op)!,
  };
}

export async function profielStand(db: Backend, clientId: string): Promise<ProfielStand> {
  const rijen = await db.query<ProfielRij>(
    `select ${KOLOMMEN} from klantprofielen
     where client_id = $1 and status in ('concept', 'ingediend', 'vastgesteld')`,
    [clientId],
  );
  const profielen = rijen.map(map);
  return {
    open: profielen.find((p) => p.status === 'concept' || p.status === 'ingediend') ?? null,
    vastgesteld: profielen.find((p) => p.status === 'vastgesteld') ?? null,
  };
}

/**
 * Wat de klant nu moet doen:
 * - `invullen`: nog geen vastgesteld profiel en niets ingediend;
 * - `vraag`: MARKaaS stuurde het profiel terug met een vraag;
 * - `ingediend`: wacht op MARKaaS;
 * - `wijziging`: vastgesteld profiel en een open wijziging in concept;
 * - `klaar`: vastgesteld, niets open.
 */
export type ProfielActie = 'invullen' | 'vraag' | 'ingediend' | 'wijziging' | 'klaar';

export function profielActie(stand: ProfielStand): ProfielActie {
  const { open, vastgesteld } = stand;
  if (open?.status === 'ingediend') return 'ingediend';
  if (open?.status === 'concept' && open.vraagVanMarkaas) return 'vraag';
  if (open?.status === 'concept') return vastgesteld ? 'wijziging' : 'invullen';
  return vastgesteld ? 'klaar' : 'invullen';
}

export interface RondeOpslag {
  clientId: string;
  /** Antwoorden van de vragen uit één ronde (vervangen de bestaande). */
  antwoorden: Antwoorden;
  /** Revisie zoals gelezen bij het openen van het formulier (0 = nog geen profiel). */
  revisie: number;
  intake: Intake;
  klok: Klok;
}

export async function slaRondeOp(db: Backend, o: RondeOpslag): Promise<Klantprofiel> {
  return await db.transaction(async (tx) => {
    const stand = await profielStand(tx, o.clientId);
    const nu = o.klok.nu().toISOString();
    if (!stand.open) {
      if (stand.vastgesteld) {
        throw new ProfielFout(
          'Uw klantprofiel is al vastgesteld. Kies "Wijziging aanvragen" om een nieuwe versie te maken.',
        );
      }
      if (o.revisie !== 0) throw new ProfielConflictFout();
      try {
        const [rij] = await tx.query<ProfielRij>(
          `insert into klantprofielen(client_id, versie, status, intake_versie, antwoorden, revisie, aangemaakt_op, bijgewerkt_op)
           values ($1, 1, 'concept', $2, $3::jsonb, 1, $4, $4)
           returning ${KOLOMMEN}`,
          [o.clientId, o.intake.versie, JSON.stringify(alleenBekendeVragen(o.intake, o.antwoorden)), nu],
        );
        return map(rij!);
      } catch (err) {
        if (isUniekFout(err)) throw new ProfielConflictFout();
        throw err;
      }
    }
    const open = stand.open;
    if (open.status === 'ingediend') {
      throw new ProfielFout(
        'Uw klantprofiel is ingediend en wordt beoordeeld door MARKaaS. Wijzigen kan weer als MARKaaS het terugstuurt, of na het vaststellen via "Wijziging aanvragen".',
      );
    }
    if (open.revisie !== o.revisie) throw new ProfielConflictFout();
    const samen = alleenBekendeVragen(o.intake, { ...open.antwoorden, ...o.antwoorden });
    const [rij] = await tx.query<ProfielRij>(
      `update klantprofielen
          set antwoorden = $2::jsonb, intake_versie = $3, revisie = revisie + 1, bijgewerkt_op = $4
        where id = $1 and revisie = $5
        returning ${KOLOMMEN}`,
      [open.id, JSON.stringify(samen), o.intake.versie, nu, o.revisie],
    );
    if (!rij) throw new ProfielConflictFout();
    return map(rij);
  });
}

export async function dienIn(
  db: Backend,
  o: {
    clientId: string;
    revisie: number;
    door: string;
    intake: Intake;
    klok: Klok;
    /** Optioneel antwoord aan MARKaaS (SPEC 0.4); leeg = geen bericht. */
    antwoord?: string;
  },
): Promise<Klantprofiel> {
  const antwoord = (o.antwoord ?? '').replace(/\r\n/g, '\n').trim();
  if (antwoord.length > MAX_ANTWOORD) {
    throw new ProfielFout(`Uw antwoord is te lang (maximaal ${MAX_ANTWOORD} tekens).`);
  }
  return await db.transaction(async (tx) => {
    const { open } = await profielStand(tx, o.clientId);
    if (!open) throw new ProfielFout('Er is nog geen klantprofiel om in te dienen. Vul eerst de vragen in.');
    if (open.status === 'ingediend') throw new ProfielFout('Het klantprofiel is al ingediend bij MARKaaS.');
    if (open.revisie !== o.revisie) throw new ProfielConflictFout();
    const ontbreekt = ontbrekendeVerplichte(o.intake, open.antwoorden);
    if (ontbreekt.length > 0) {
      throw new ProfielFout(`Nog niet alle verplichte vragen zijn beantwoord: ${ontbreekt.join(' · ')}.`);
    }
    const [rij] = await tx.query<ProfielRij>(
      `update klantprofielen
          set status = 'ingediend', ingediend_door = $2, ingediend_op = $3, bijgewerkt_op = $3,
              vraag_van_markaas = null, revisie = revisie + 1
        where id = $1 and revisie = $4
        returning ${KOLOMMEN}`,
      [open.id, o.door, o.klok.nu().toISOString(), o.revisie],
    );
    if (!rij) throw new ProfielConflictFout();
    if (antwoord) {
      await voegBerichtToe(tx, {
        profielId: open.id,
        clientId: o.clientId,
        van: 'klant',
        tekst: antwoord,
        door: o.door,
        op: o.klok.nu().toISOString(),
      });
    }
    return map(rij);
  });
}

/** Beheerder: ingediend profiel terug naar concept, met een vraag aan de klant. */
export async function stuurTerug(
  db: Backend,
  o: { clientId: string; vraag: string; klok: Klok; door?: string },
): Promise<Klantprofiel> {
  const vraag = o.vraag.replace(/\r\n/g, '\n').trim().slice(0, MAX_VRAAG);
  if (!vraag) throw new ProfielFout('Vul een vraag of toelichting in voor de klant.');
  return await db.transaction(async (tx) => {
    const { open } = await profielStand(tx, o.clientId);
    if (open?.status !== 'ingediend') throw new ProfielFout('Er is geen ingediend klantprofiel om terug te sturen.');
    const nu = o.klok.nu().toISOString();
    const [rij] = await tx.query<ProfielRij>(
      `update klantprofielen
          set status = 'concept', vraag_van_markaas = $2, bijgewerkt_op = $3, revisie = revisie + 1
        where id = $1 and status = 'ingediend'
        returning ${KOLOMMEN}`,
      [open.id, vraag, nu],
    );
    if (!rij) throw new ProfielFout('Het klantprofiel is intussen gewijzigd; laad de pagina opnieuw.');
    await voegBerichtToe(tx, { profielId: open.id, clientId: o.clientId, van: 'markaas', tekst: vraag, door: o.door ?? 'rubert', op: nu });
    return map(rij);
  });
}

/** Beheerder: ingediend profiel vaststellen; de vorige vastgestelde versie wordt vervangen. */
export async function stelVast(
  db: Backend,
  o: { clientId: string; interneAanvulling: string; door: string; klok: Klok },
): Promise<Klantprofiel> {
  const aanvulling = o.interneAanvulling.replace(/\r\n/g, '\n').trim();
  if (aanvulling.length > MAX_INTERNE_AANVULLING) {
    throw new ProfielFout(`De interne aanvulling is te lang (maximaal ${MAX_INTERNE_AANVULLING} tekens).`);
  }
  return await db.transaction(async (tx) => {
    const { open } = await profielStand(tx, o.clientId);
    if (open?.status !== 'ingediend') {
      throw new ProfielFout('Alleen een ingediend klantprofiel kan worden vastgesteld.');
    }
    const nu = o.klok.nu().toISOString();
    await tx.query(
      `update klantprofielen set status = 'vervangen', bijgewerkt_op = $2
        where client_id = $1 and status = 'vastgesteld'`,
      [o.clientId, nu],
    );
    const [rij] = await tx.query<ProfielRij>(
      `update klantprofielen
          set status = 'vastgesteld', interne_aanvulling = $2, vastgesteld_door = $3,
              vastgesteld_op = $4, bijgewerkt_op = $4, revisie = revisie + 1
        where id = $1 and status = 'ingediend'
        returning ${KOLOMMEN}`,
      [open.id, aanvulling, o.door, nu],
    );
    if (!rij) throw new ProfielFout('Het klantprofiel is intussen gewijzigd; laad de pagina opnieuw.');
    return map(rij);
  });
}

/** Beheerder: interne aanvulling van het vastgestelde profiel bijwerken (geen nieuwe versie). */
export async function werkInterneAanvullingBij(
  db: Backend,
  o: { clientId: string; interneAanvulling: string; klok: Klok },
): Promise<Klantprofiel> {
  const aanvulling = o.interneAanvulling.replace(/\r\n/g, '\n').trim();
  if (aanvulling.length > MAX_INTERNE_AANVULLING) {
    throw new ProfielFout(`De interne aanvulling is te lang (maximaal ${MAX_INTERNE_AANVULLING} tekens).`);
  }
  const [rij] = await db.query<ProfielRij>(
    `update klantprofielen set interne_aanvulling = $2, bijgewerkt_op = $3
      where client_id = $1 and status = 'vastgesteld'
      returning ${KOLOMMEN}`,
    [o.clientId, aanvulling, o.klok.nu().toISOString()],
  );
  if (!rij) throw new ProfielFout('Er is nog geen vastgesteld klantprofiel om aan te vullen.');
  return map(rij);
}

/**
 * Klant: nieuwe conceptversie op basis van de vastgestelde. Staat er al iets
 * open, dan wordt dat teruggegeven (dubbel klikken maakt geen tweede versie).
 */
export async function vraagWijzigingAan(
  db: Backend,
  o: { clientId: string; klok: Klok },
): Promise<Klantprofiel> {
  return await db.transaction(async (tx) => {
    const { open, vastgesteld } = await profielStand(tx, o.clientId);
    if (open) return open;
    if (!vastgesteld) throw new ProfielFout('Er is nog geen vastgesteld klantprofiel; vul eerst de vragen in.');
    const nu = o.klok.nu().toISOString();
    try {
      const [rij] = await tx.query<ProfielRij>(
        `insert into klantprofielen(client_id, versie, status, intake_versie, antwoorden, interne_aanvulling,
                                    revisie, aangemaakt_op, bijgewerkt_op)
         select client_id, (select max(versie) + 1 from klantprofielen where client_id = $1), 'concept',
                intake_versie, antwoorden, interne_aanvulling, 1, $2, $2
           from klantprofielen where id = $3
         returning ${KOLOMMEN}`,
        [o.clientId, nu, vastgesteld.id],
      );
      return map(rij!);
    } catch (err) {
      // Een collega opende tegelijk een wijziging; de transactie is dan afgebroken.
      if (isUniekFout(err)) throw new ProfielFout('Er is intussen al een wijziging geopend; laad de pagina opnieuw.');
      throw err;
    }
  });
}

export interface ProfielVoorSkill {
  klantNaam: string;
  clientSlug: string;
  vastgesteld: Klantprofiel | null;
  /** Status van een nieuwere open versie, of null. */
  nieuwereVersie: { versie: number; status: 'concept' | 'ingediend' } | null;
}

/** Voor de MCP-tool `get_klantprofiel`: alleen actieve klanten. */
export async function profielVoorSlug(db: Backend, slug: string): Promise<ProfielVoorSkill | null> {
  const [klant] = await db.query<{ id: string; naam: string; slug: string }>(
    'select id, naam, slug from clients where slug = $1 and actief = true',
    [slug],
  );
  if (!klant) return null;
  const stand = await profielStand(db, klant.id);
  return {
    klantNaam: klant.naam,
    clientSlug: klant.slug,
    vastgesteld: stand.vastgesteld,
    nieuwereVersie: stand.open
      ? { versie: stand.open.versie, status: stand.open.status as 'concept' | 'ingediend' }
      : null,
  };
}

function isUniekFout(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23505' || /duplicate key|unique/i.test(e?.message ?? '');
}
