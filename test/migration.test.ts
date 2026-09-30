import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { draaiMigraties } from '../src/db/migrator.ts';

import { MIGRATIE_MAP, verseDatabaseMetMigraties, versePglite } from './helpers/pglite.ts';

const VERWACHTE_TABELLEN = [
  'accounts',
  'actions',
  'clients',
  'events',
  'schema_migrations',
  'sequences',
  'usage',
];

describe('0001_init.sql', () => {
  it('past de migratie schoon toe op een verse PGlite', async () => {
    const { db, toegepast, close } = await verseDatabaseMetMigraties();
    try {
      assert.deepEqual(toegepast, ['0001_init.sql']);

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
      assert.deepEqual(rijen.map((r) => r.naam), ['0001_init.sql']);
    } finally {
      await close();
    }
  });

  it('is idempotent: tweede aanroep past niets nieuws toe', async () => {
    const { db, close } = await versePglite();
    try {
      const eerste = await draaiMigraties(db, MIGRATIE_MAP);
      const tweede = await draaiMigraties(db, MIGRATIE_MAP);
      assert.deepEqual(eerste, ['0001_init.sql']);
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
