import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { registreerAccount, markeerAccountGekoppeld } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { vasteKlok } from './klok.ts';
import { laadLimieten } from './limits.ts';
import { telGebruikOpDag } from './gebruik.ts';
import { reserveerEnVerbruik } from './verbruik.ts';

async function versAccount(opties: {
  openstaand?: number;
  afkoelingTot?: string | null;
  opbouwFactor?: number;
  /** Betaalpoort (SPEC §14.4); standaard uit zodat de budgettests er los van staan. */
  abonnementVereist?: boolean;
  abonnementStatus?: string;
} = {}) {
  const h = await verseDatabaseMetMigraties();
  const client = await maakClient(h.db, {
    naam: 'ACME BV',
    slug: 'acme',
    abonnementVereist: opties.abonnementVereist ?? false,
  });
  if (opties.abonnementStatus) {
    await h.db.query('insert into subscriptions(client_id, status) values ($1, $2)', [
      client.id,
      opties.abonnementStatus,
    ]);
  }
  const account = await registreerAccount(h.db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  await markeerAccountGekoppeld(h.db, account.id, 'unipile-acc-1');
  const sets: string[] = [];
  const params: unknown[] = [account.id];
  if (opties.openstaand !== undefined) {
    sets.push(`openstaande_verzoeken = $${params.length + 1}`);
    params.push(opties.openstaand);
  }
  if (opties.afkoelingTot !== undefined) {
    sets.push(`afkoeling_tot = $${params.length + 1}`);
    params.push(opties.afkoelingTot);
  }
  if (opties.opbouwFactor !== undefined) {
    sets.push(`opbouw_factor = $${params.length + 1}`);
    params.push(opties.opbouwFactor);
  }
  if (sets.length > 0) {
    await h.db.query(
      `update accounts set ${sets.join(', ')} where id = $1`,
      params,
    );
  }
  return { ...h, accountId: account.id };
}

describe('reserveerEnVerbruik — toegestane actie', () => {
  it('increaseert de usage-teller met 1 als de actie wordt toegestaan', async () => {
    const h = await versAccount();
    try {
      const l = await laadLimieten();
      // Dinsdag 2026-10-06 12:00 Europe/Amsterdam = 10:00 UTC → werkuren.
      const klok = vasteKlok('2026-10-06T10:00:00Z');
      const uitslag = await reserveerEnVerbruik(h.db, {
        accountId: h.accountId,
        actieType: 'invite',
        goedgekeurd: true,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
      });
      assert.equal(uitslag.status, 'toegestaan');
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-06'), 1);
    } finally {
      await h.close();
    }
  });
});

describe('reserveerEnVerbruik — weigering en wachtrij veranderen de teller niet', () => {
  it('tijdens afkoeling wordt niets geteld', async () => {
    const h = await versAccount({ afkoelingTot: '2026-10-07T00:00:00Z' });
    try {
      const l = await laadLimieten();
      const klok = vasteKlok('2026-10-06T10:00:00Z');
      const uitslag = await reserveerEnVerbruik(h.db, {
        accountId: h.accountId,
        actieType: 'invite',
        goedgekeurd: true,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
      });
      assert.equal(uitslag.status, 'wachtrij');
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-06'), 0);
    } finally {
      await h.close();
    }
  });

  it('zonder goedkeuring (weigering) wordt niets geteld', async () => {
    const h = await versAccount();
    try {
      const l = await laadLimieten();
      const klok = vasteKlok('2026-10-06T10:00:00Z');
      const uitslag = await reserveerEnVerbruik(h.db, {
        accountId: h.accountId,
        actieType: 'invite',
        goedgekeurd: false,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
      });
      assert.equal(uitslag.status, 'weigering');
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-06'), 0);
    } finally {
      await h.close();
    }
  });
});

describe('reserveerEnVerbruik — gelijktijdigheid', () => {
  it('twee gelijktijdige verzoeken komen samen nooit over de grens', async () => {
    const h = await versAccount({ opbouwFactor: 0.5 });
    try {
      const l = await laadLimieten();
      // Dagnorm invites salesnav_core = 20; met opbouw 0.5 → 10.
      // Vul vandaag al tot 9: één van twee gelijktijdige acties mag door.
      await h.db.query(
        `insert into usage(account_id, type, dag, aantal)
         values ($1, 'invite'::action_type, '2026-10-06'::date, 9)`,
        [h.accountId],
      );
      const klok = vasteKlok('2026-10-06T10:00:00Z');
      const invoer = {
        accountId: h.accountId,
        actieType: 'invite' as const,
        goedgekeurd: true,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
      };
      const [uit1, uit2] = await Promise.all([
        reserveerEnVerbruik(h.db, invoer),
        reserveerEnVerbruik(h.db, invoer),
      ]);
      const statussen = [uit1.status, uit2.status].sort();
      assert.deepEqual(statussen, ['toegestaan', 'wachtrij']);
      // Teller mag niet boven 10 komen; mag 10 zijn.
      const teller = await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-06');
      assert.equal(teller, 10);
    } finally {
      await h.close();
    }
  });

  it('bij veel gelijktijdige verzoeken wordt het resterende budget correct opgedeeld', async () => {
    const h = await versAccount({ opbouwFactor: 1.0 });
    try {
      const l = await laadLimieten();
      // Dagnorm invites salesnav_core = 20, factor 1.0 → 20.
      // Al 15 verbruikt → ruimte voor 5.
      await h.db.query(
        `insert into usage(account_id, type, dag, aantal)
         values ($1, 'invite'::action_type, '2026-10-06'::date, 15)`,
        [h.accountId],
      );
      const klok = vasteKlok('2026-10-06T10:00:00Z');
      const invoer = {
        accountId: h.accountId,
        actieType: 'invite' as const,
        goedgekeurd: true,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
      };
      const uitslagen = await Promise.all(
        Array.from({ length: 10 }, () => reserveerEnVerbruik(h.db, invoer)),
      );
      const toegestaan = uitslagen.filter((u) => u.status === 'toegestaan').length;
      const wachtrij = uitslagen.filter((u) => u.status === 'wachtrij').length;
      assert.equal(toegestaan, 5);
      assert.equal(wachtrij, 5);
      const teller = await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-06');
      assert.equal(teller, 20);
    } finally {
      await h.close();
    }
  });
});

describe('reserveerEnVerbruik — leest week- en maandverbruik', () => {
  it('rolt het 7-daagse weekvenster correct door', async () => {
    const h = await versAccount();
    try {
      const l = await laadLimieten();
      // Week-norm salesnav_core.invite.week = 100 (zonder bonus → wekenSindsStart < 4).
      // Vul 100 totaal verdeeld over 2026-10-01 .. 2026-10-06 (allemaal binnen 7 dagen).
      for (const dag of [
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05',
      ]) {
        await h.db.query(
          `insert into usage(account_id, type, dag, aantal)
           values ($1, 'invite'::action_type, $2::date, 20)
           on conflict (account_id, type, dag) do update set aantal = excluded.aantal`,
          [h.accountId, dag],
        );
      }
      const klok = vasteKlok('2026-10-06T10:00:00Z');
      const uitslag = await reserveerEnVerbruik(h.db, {
        accountId: h.accountId,
        actieType: 'invite',
        goedgekeurd: true,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
        wekenSindsStart: 2, // geen bonus
      });
      assert.equal(uitslag.status, 'wachtrij');
      assert.equal(uitslag.controle, 'weekbudget');
    } finally {
      await h.close();
    }
  });

  it('inmail leest maandverbruik uit usage-tabel', async () => {
    const h = await versAccount();
    try {
      const l = await laadLimieten();
      // premium_business.inmail.maand = 15. Simuleer salesnav_core (50/maand) → vul 50.
      // Update account naar premium_business om de test eenvoudiger te maken.
      await h.db.query(
        `update accounts set abonnement = 'premium_business'::account_subscription where id = $1`,
        [h.accountId],
      );
      for (let d = 1; d <= 15; d++) {
        await h.db.query(
          `insert into usage(account_id, type, dag, aantal)
           values ($1, 'inmail'::action_type, $2::date, 1)`,
          [h.accountId, `2026-10-${String(d).padStart(2, '0')}`],
        );
      }
      const klok = vasteKlok('2026-10-20T10:00:00Z');
      const uitslag = await reserveerEnVerbruik(h.db, {
        accountId: h.accountId,
        actieType: 'inmail',
        goedgekeurd: true,
        klok,
        limieten: l,
        minPauzeSeconden: 0,
      });
      assert.equal(uitslag.status, 'wachtrij');
      assert.match(uitslag.reden!, /maand/i);
    } finally {
      await h.close();
    }
  });
});

describe('reserveerEnVerbruik — betaalpoort (SPEC §14.4)', () => {
  const klok = vasteKlok('2026-10-06T10:00:00Z');

  async function probeer(h: Awaited<ReturnType<typeof versAccount>>, actieType: 'invite' | 'search' | 'profile') {
    return await reserveerEnVerbruik(h.db, {
      accountId: h.accountId,
      actieType,
      goedgekeurd: true,
      klok,
      limieten: await laadLimieten(),
      minPauzeSeconden: 0,
    });
  }

  it('klant met abonnementsplicht zonder abonnement: invite geweigerd, niets geteld', async () => {
    const h = await versAccount({ abonnementVereist: true });
    try {
      const uitslag = await probeer(h, 'invite');
      assert.equal(uitslag.status, 'weigering');
      assert.equal(uitslag.status === 'weigering' && uitslag.controle, 'abonnement');
      assert.match(uitslag.status === 'weigering' ? uitslag.reden : '', /Abonnement niet actief/);
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-06'), 0);
      // Zoeken en profielen blijven mogelijk.
      assert.equal((await probeer(h, 'search')).status, 'toegestaan');
      assert.equal((await probeer(h, 'profile')).status, 'toegestaan');
    } finally {
      await h.close();
    }
  });

  it('met een abonnement in proefperiode: invite toegestaan', async () => {
    const h = await versAccount({ abonnementVereist: true, abonnementStatus: 'trialing' });
    try {
      assert.equal((await probeer(h, 'invite')).status, 'toegestaan');
    } finally {
      await h.close();
    }
  });

  it('beëindigd abonnement: geweigerd', async () => {
    const h = await versAccount({ abonnementVereist: true, abonnementStatus: 'canceled' });
    try {
      assert.equal((await probeer(h, 'invite')).status, 'weigering');
    } finally {
      await h.close();
    }
  });
});
