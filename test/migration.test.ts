import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { draaiMigraties } from '../src/db/migrator.ts';

import { MIGRATIE_MAP, verseDatabaseMetMigraties, versePglite } from './helpers/pglite.ts';

const VERWACHTE_TABELLEN = [
  'account_consents',
  'accounts',
  'actions',
  'client_user_uitnodigingen',
  'client_users',
  'clients',
  'events',
  'klantprofiel_berichten',
  'klantprofielen',
  'koppel_uitnodigingen',
  'portal_sessions',
  'schema_migrations',
  'sequences',
  'subscriptions',
  'usage',
];

const ALLE_MIGRATIES = [
  '0001_init.sql',
  '0002_sequences.sql',
  '0003_sequenties_herstart.sql',
  '0004_onboarding.sql',
  '0005_klantportaal.sql',
  '0006_abonnementen.sql',
  '0007_toestemming_momentopname.sql',
  '0008_klantprofielen.sql',
  '0009_klantprofiel_berichten.sql',
];

describe('0001_init.sql', () => {
  it('past de migratie schoon toe op een verse PGlite', async () => {
    const { db, toegepast, close } = await verseDatabaseMetMigraties();
    try {
      assert.deepEqual(toegepast, ALLE_MIGRATIES);

      const rijen = await db.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      assert.deepEqual(rijen.map((r) => r.tablename), VERWACHTE_TABELLEN);
    } finally {
      await close();
    }
  });

  it('registreert de toegepaste migratie in schema_migrations', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const rijen = await db.query<{ naam: string }>(
        'select naam from schema_migrations order by naam',
      );
      assert.deepEqual(rijen.map((r) => r.naam), ALLE_MIGRATIES);
    } finally {
      await close();
    }
  });

  it('is idempotent: tweede aanroep past niets nieuws toe', async () => {
    const { db, close } = await versePglite();
    try {
      const eerste = await draaiMigraties(db, MIGRATIE_MAP);
      const tweede = await draaiMigraties(db, MIGRATIE_MAP);
      assert.deepEqual(eerste, ALLE_MIGRATIES);
      assert.deepEqual(tweede, []);
    } finally {
      await close();
    }
  });

  it('handhaaft de check op opbouw_factor (>= 0.50 en <= 1.00)', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('Test-klant', 'test-klant') returning id",
      );
      assert.ok(client, 'client aangemaakt');

      await assert.rejects(
        db.query(
          `insert into accounts(client_id, eigenaar_naam, abonnement, opbouw_factor)
           values ($1, 'Rubert', 'salesnav_core', 0.30)`,
          [client.id],
        ),
        /opbouw_factor/,
      );

      await assert.rejects(
        db.query(
          `insert into accounts(client_id, eigenaar_naam, abonnement, opbouw_factor)
           values ($1, 'Rubert', 'salesnav_core', 1.20)`,
          [client.id],
        ),
        /opbouw_factor/,
      );
    } finally {
      await close();
    }
  });

  it('weigert een onbekende abonnement-waarde (enum)', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('Test-klant', 'test-klant') returning id",
      );
      assert.ok(client);
      await assert.rejects(
        db.query(
          `insert into accounts(client_id, eigenaar_naam, abonnement)
           values ($1, 'Rubert', 'onbekend')`,
          [client.id],
        ),
        /account_subscription|invalid input value/i,
      );
    } finally {
      await close();
    }
  });

  it('accepteert de nieuwe account_status-waarden PERMISSIONS en UNKNOWN', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('Test-klant', 'test-klant') returning id",
      );
      assert.ok(client);
      for (const nieuweStatus of ['PERMISSIONS', 'UNKNOWN']) {
        const rijen: Array<{ status: string }> = await db.query<{ status: string }>(
          `insert into accounts(client_id, eigenaar_naam, abonnement, status)
           values ($1, 'Rubert', 'salesnav_core', $2::account_status) returning status`,
          [client.id, nieuweStatus],
        );
        assert.equal(rijen[0]?.status, nieuweStatus);
      }
    } finally {
      await close();
    }
  });

  it('start openstaande_verzoeken op 0 en weigert negatieve waarden', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('Test-klant', 'test-klant') returning id",
      );
      assert.ok(client);
      const [account] = await db.query<{ openstaande_verzoeken: number }>(
        `insert into accounts(client_id, eigenaar_naam, abonnement)
         values ($1, 'Rubert', 'salesnav_core') returning openstaande_verzoeken`,
        [client.id],
      );
      assert.equal(account?.openstaande_verzoeken, 0);

      await assert.rejects(
        db.query(
          `insert into accounts(client_id, eigenaar_naam, abonnement, openstaande_verzoeken)
           values ($1, 'Rubert', 'salesnav_core', -1)`,
          [client.id],
        ),
        /openstaande_verzoeken/,
      );
    } finally {
      await close();
    }
  });

  it('afdwingt uniciteit van (bron, extern_id) in events maar staat meerdere null-waarden toe', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      await db.query(
        `insert into events(bron, type, extern_id, payload)
         values ('unipile', 'account_status', 'evt-abc', '{}'::jsonb)`,
      );
      await assert.rejects(
        db.query(
          `insert into events(bron, type, extern_id, payload)
           values ('unipile', 'account_status', 'evt-abc', '{}'::jsonb)`,
        ),
        /duplicate|unique/i,
      );

      await db.query(
        `insert into events(bron, type, extern_id, payload)
         values ('unipile', 'account_status', 'evt-def', '{}'::jsonb)`,
      );

      await db.query(
        `insert into events(bron, type, payload)
         values ('gateway', 'notitie', '{}'::jsonb)`,
      );
      await db.query(
        `insert into events(bron, type, payload)
         values ('gateway', 'notitie', '{}'::jsonb)`,
      );

      const [rij] = await db.query<{ aantal: string }>('select count(*)::text as aantal from events');
      assert.equal(rij?.aantal, '4');
    } finally {
      await close();
    }
  });

  it('0002: voegt lead-metadata, teksten en stop_reden toe aan sequences', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const kolommen = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'sequences'
         order by column_name`,
      );
      const namen = new Set(kolommen.map((k) => k.column_name));
      for (const verwacht of [
        'lead_naam',
        'lead_functie',
        'lead_bedrijf',
        'waarom',
        'tekst_invite',
        'tekst_bericht',
        'tekst_opvolging',
        'stop_reden',
      ]) {
        assert.ok(namen.has(verwacht), `kolom ${verwacht} ontbreekt in sequences`);
      }
    } finally {
      await close();
    }
  });

  it('0002: voegt sequence_id en sequence_stap toe aan actions, met FK en check', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const kolommen = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'actions'
         order by column_name`,
      );
      const namen = new Set(kolommen.map((k) => k.column_name));
      assert.ok(namen.has('sequence_id'));
      assert.ok(namen.has('sequence_stap'));

      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('T', 't') returning id",
      );
      const [account] = await db.query<{ id: string }>(
        `insert into accounts(client_id, eigenaar_naam, abonnement)
         values ($1, 'R', 'salesnav_core') returning id`,
        [client!.id],
      );
      const [sequentie] = await db.query<{ id: string }>(
        `insert into sequences(account_id, lead_linkedin_url)
         values ($1, 'https://www.linkedin.com/in/x') returning id`,
        [account!.id],
      );

      // sequence_stap moet 1..3 zijn.
      await assert.rejects(
        db.query(
          `insert into actions(account_id, type, payload, sequence_id, sequence_stap)
           values ($1, 'invite', '{}'::jsonb, $2, 0)`,
          [account!.id, sequentie!.id],
        ),
        /sequence_stap/,
      );
      await assert.rejects(
        db.query(
          `insert into actions(account_id, type, payload, sequence_id, sequence_stap)
           values ($1, 'invite', '{}'::jsonb, $2, 4)`,
          [account!.id, sequentie!.id],
        ),
        /sequence_stap/,
      );
      await db.query(
        `insert into actions(account_id, type, payload, sequence_id, sequence_stap)
         values ($1, 'invite', '{}'::jsonb, $2, 1)`,
        [account!.id, sequentie!.id],
      );
    } finally {
      await close();
    }
  });

  it('afdwingt uniciteit van sequences per account en lead-url', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('Test-klant', 'test-klant') returning id",
      );
      assert.ok(client);
      const [account] = await db.query<{ id: string }>(
        `insert into accounts(client_id, eigenaar_naam, abonnement)
         values ($1, 'Rubert', 'salesnav_core') returning id`,
        [client.id],
      );
      assert.ok(account);

      await db.query(
        `insert into sequences(account_id, lead_linkedin_url)
         values ($1, 'https://www.linkedin.com/in/voorbeeld')`,
        [account.id],
      );
      await assert.rejects(
        db.query(
          `insert into sequences(account_id, lead_linkedin_url)
           values ($1, 'https://www.linkedin.com/in/voorbeeld')`,
          [account.id],
        ),
        /duplicate|unique/i,
      );
    } finally {
      await close();
    }
  });
});

describe('0004_onboarding.sql', () => {
  it('zet abonnement_vereist op false voor markaas en laat andere bestaande klanten op true', async () => {
    const { db, close } = await versePglite();
    try {
      // Simuleer een database waarop 0001–0003 al draaiden, met bestaande klanten.
      await db.exec(`create table schema_migrations (
        naam text primary key, toegepast_op timestamptz not null default now())`);
      for (const naam of ALLE_MIGRATIES.slice(0, 3)) {
        await db.exec(await readFile(join(MIGRATIE_MAP, naam), 'utf8'));
        await db.query('insert into schema_migrations(naam) values ($1)', [naam]);
      }
      await db.query(
        "insert into clients(naam, slug) values ('MARKaaS', 'markaas'), ('Aqua', 'aqua')",
      );
      const nieuw = await draaiMigraties(db, MIGRATIE_MAP);
      assert.deepEqual(nieuw, [
        '0004_onboarding.sql',
        '0005_klantportaal.sql',
        '0006_abonnementen.sql',
        '0007_toestemming_momentopname.sql',
        '0008_klantprofielen.sql',
        '0009_klantprofiel_berichten.sql',
      ]);
      const rijen = await db.query<{ slug: string; abonnement_vereist: boolean }>(
        'select slug, abonnement_vereist from clients order by slug',
      );
      assert.deepEqual(rijen, [
        { slug: 'aqua', abonnement_vereist: true },
        { slug: 'markaas', abonnement_vereist: false },
      ]);
      // Nieuwe klanten krijgen standaard true.
      await db.query("insert into clients(naam, slug) values ('Nieuw', 'nieuw')");
      const [nieuwRij] = await db.query<{ abonnement_vereist: boolean }>(
        "select abonnement_vereist from clients where slug = 'nieuw'",
      );
      assert.equal(nieuwRij?.abonnement_vereist, true);
    } finally {
      await close();
    }
  });

  it('dwingt unieke token_hash af en ruimt uitnodigingen en toestemmingen op met het account', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [client] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('K', 'k') returning id",
      );
      const [account] = await db.query<{ id: string }>(
        `insert into accounts(client_id, eigenaar_naam, eigenaar_email, abonnement)
         values ($1, 'Eva', 'eva@voorbeeld.nl', 'free') returning id`,
        [client!.id],
      );
      const [uitn] = await db.query<{ id: string }>(
        `insert into koppel_uitnodigingen(account_id, token_hash, verloopt_op)
         values ($1, 'hash-1', now() + interval '7 days') returning id`,
        [account!.id],
      );
      await assert.rejects(
        db.query(
          `insert into koppel_uitnodigingen(account_id, token_hash, verloopt_op)
           values ($1, 'hash-1', now())`,
          [account!.id],
        ),
        /duplicate|unique/i,
      );
      await db.query(
        `insert into account_consents(account_id, uitnodiging_id, naam, email,
           versie_voorwaarden, versie_verwerkersovereenkomst)
         values ($1, $2, 'Eva', 'eva@voorbeeld.nl', '0.1', '0.1')`,
        [account!.id, uitn!.id],
      );
      await db.query('delete from accounts where id = $1', [account!.id]);
      const [telling] = await db.query<{ u: number; c: number; z: number }>(
        `select (select count(*)::int from koppel_uitnodigingen) as u,
                (select count(*)::int from account_consents) as c,
                (select count(*)::int from account_consents where account_id is null and uitnodiging_id is null) as z`,
      );
      // Uitnodigingen gaan mee met het account; toestemming blijft als bewijs bewaard.
      assert.deepEqual(telling, { u: 0, c: 1, z: 1 });
    } finally {
      await close();
    }
  });
});

describe('0005_klantportaal.sql', () => {
  it('dwingt kleine letters en een uniek e-mailadres af voor klantgebruikers', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [a] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('A', 'a') returning id",
      );
      const [b] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('B', 'b') returning id",
      );
      await db.query(
        "insert into client_users(client_id, email, naam) values ($1, 'jan@a.nl', 'Jan')",
        [a!.id],
      );
      await assert.rejects(
        db.query(
          "insert into client_users(client_id, email, naam) values ($1, 'Piet@A.nl', 'Piet')",
          [a!.id],
        ),
        /check|email/i,
      );
      // Uniek over alle klanten heen.
      await assert.rejects(
        db.query(
          "insert into client_users(client_id, email, naam) values ($1, 'jan@a.nl', 'Jan B')",
          [b!.id],
        ),
        /duplicate|unique/i,
      );
    } finally {
      await close();
    }
  });

  it('ruimt gebruikers, uitnodigingen en sessies op met de klant en heeft actions.afgewezen_door', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [k] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('K', 'k') returning id",
      );
      const [u] = await db.query<{ id: string }>(
        "insert into client_users(client_id, email, naam) values ($1, 'eva@k.nl', 'Eva') returning id",
        [k!.id],
      );
      await db.query(
        `insert into client_user_uitnodigingen(client_user_id, token_hash, verloopt_op)
         values ($1, 'h1', now() + interval '7 days')`,
        [u!.id],
      );
      await assert.rejects(
        db.query(
          `insert into client_user_uitnodigingen(client_user_id, token_hash, verloopt_op)
           values ($1, 'h1', now())`,
          [u!.id],
        ),
        /duplicate|unique/i,
      );
      await db.query(
        `insert into portal_sessions(id, client_user_id, csrf_token, verloopt_op)
         values ('sessiehash', $1, 'csrf', now() + interval '12 hours')`,
        [u!.id],
      );
      await db.query('delete from clients where id = $1', [k!.id]);
      const [telling] = await db.query<{ u: number; i: number; s: number }>(
        `select (select count(*)::int from client_users) as u,
                (select count(*)::int from client_user_uitnodigingen) as i,
                (select count(*)::int from portal_sessions) as s`,
      );
      assert.deepEqual(telling, { u: 0, i: 0, s: 0 });
      const kolommen = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'actions' and column_name = 'afgewezen_door'`,
      );
      assert.equal(kolommen.length, 1);
    } finally {
      await close();
    }
  });
});

describe('0006_abonnementen.sql', () => {
  it('één abonnement per klant, unieke Stripe-id\'s, opruimen met de klant', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [k] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('K', 'k') returning id",
      );
      const [l] = await db.query<{ id: string }>(
        "insert into clients(naam, slug) values ('L', 'l') returning id",
      );
      await db.query(
        `insert into subscriptions(client_id, stripe_customer_id, stripe_subscription_id, status)
         values ($1, 'cus_1', 'sub_1', 'trialing')`,
        [k!.id],
      );
      await assert.rejects(
        db.query(`insert into subscriptions(client_id) values ($1)`, [k!.id]),
        /duplicate|unique/i,
      );
      await assert.rejects(
        db.query(`insert into subscriptions(client_id, stripe_customer_id) values ($1, 'cus_1')`, [l!.id]),
        /duplicate|unique/i,
      );
      const [rij] = await db.query<{ opgezegd_per_einde: boolean }>(
        'select opgezegd_per_einde from subscriptions where client_id = $1',
        [k!.id],
      );
      assert.equal(rij!.opgezegd_per_einde, false);
      await db.query('delete from clients where id = $1', [k!.id]);
      const [telling] = await db.query<{ n: number }>('select count(*)::int as n from subscriptions');
      assert.equal(telling!.n, 0);
    } finally {
      await close();
    }
  });

  it('events accepteert bron stripe en ontdubbelt op extern_id', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      await db.query(
        "insert into events(bron, type, extern_id, payload) values ('stripe', 'invoice.paid', 'stripe:evt_1', '{}')",
      );
      await assert.rejects(
        db.query(
          "insert into events(bron, type, extern_id, payload) values ('stripe', 'invoice.paid', 'stripe:evt_1', '{}')",
        ),
        /duplicate|unique/i,
      );
    } finally {
      await close();
    }
  });
});

describe('0007_toestemming_momentopname.sql', () => {
  it('vult bestaande toestemmingen aan en houdt het bewijs na verwijderen van account en klant', async () => {
    const { db, close } = await versePglite();
    try {
      await db.exec(`create table schema_migrations (
        naam text primary key, toegepast_op timestamptz not null default now())`);
      for (const naam of ALLE_MIGRATIES.slice(0, 6)) {
        await db.exec(await readFile(join(MIGRATIE_MAP, naam), 'utf8'));
        await db.query('insert into schema_migrations(naam) values ($1)', [naam]);
      }
      const [k] = await db.query<{ id: string }>("insert into clients(naam, slug) values ('Aqua', 'aqua') returning id");
      const [a] = await db.query<{ id: string }>(
        "insert into accounts(client_id, eigenaar_naam, abonnement, unipile_account_id) values ($1, 'Eva', 'free', 'uni-1') returning id",
        [k!.id],
      );
      await db.query(
        `insert into account_consents(account_id, naam, email, versie_voorwaarden, versie_verwerkersovereenkomst)
         values ($1, 'Eva', 'eva@aqua.nl', '0.1', '0.1')`,
        [a!.id],
      );
      assert.deepEqual(await draaiMigraties(db, MIGRATIE_MAP), [
        '0007_toestemming_momentopname.sql',
        '0008_klantprofielen.sql',
        '0009_klantprofiel_berichten.sql',
      ]);
      const [r] = await db.query<Record<string, unknown>>(
        'select client_id, klantnaam, account_eigenaar_naam, unipile_account_id from account_consents',
      );
      assert.deepEqual(r, { client_id: k!.id, klantnaam: 'Aqua', account_eigenaar_naam: 'Eva', unipile_account_id: 'uni-1' });
      await db.query('delete from accounts where id = $1', [a!.id]);
      await db.query('delete from clients where id = $1', [k!.id]);
      const [na] = await db.query<Record<string, unknown>>(
        'select account_id, client_id, klantnaam, account_eigenaar_naam from account_consents',
      );
      assert.deepEqual(na, { account_id: null, client_id: null, klantnaam: 'Aqua', account_eigenaar_naam: 'Eva' });
    } finally {
      await close();
    }
  });
});

describe('0008_klantprofielen.sql', () => {
  it('staat per klant hooguit één open en één vastgestelde versie toe; verwijderen van de klant ruimt op', async () => {
    const { db, close } = await verseDatabaseMetMigraties();
    try {
      const [k] = await db.query<{ id: string }>("insert into clients(naam, slug) values ('TAG', 'tag') returning id");
      const nieuw = (versie: number, status: string) =>
        db.query(
          "insert into klantprofielen(client_id, versie, status, intake_versie) values ($1, $2, $3, '1')",
          [k!.id, versie, status],
        );
      await nieuw(1, 'vastgesteld');
      await nieuw(2, 'concept');
      await assert.rejects(() => nieuw(3, 'ingediend'), /unique|duplicate/i);
      await assert.rejects(() => nieuw(3, 'vastgesteld'), /unique|duplicate/i);
      await assert.rejects(() => nieuw(2, 'vervangen'), /unique|duplicate/i);
      await assert.rejects(() => nieuw(4, 'gek'), /check/i);
      await nieuw(3, 'vervangen');
      await db.query('delete from clients where id = $1', [k!.id]);
      const [{ aantal }] = (await db.query<{ aantal: number }>('select count(*)::int as aantal from klantprofielen')) as [
        { aantal: number },
      ];
      assert.equal(aantal, 0);
    } finally {
      await close();
    }
  });
});
