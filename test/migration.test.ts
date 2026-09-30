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
