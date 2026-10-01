import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { leesEnv } from './env.ts';

const volledig = {
  UNIPILE_DSN: 'api68.unipile.com:19841',
  UNIPILE_API_KEY: 'geheime-sleutel-abc',
  WEBHOOK_SECRET: 'webhook-geheim-xyz',
  MCP_TOKEN: 'mcp-geheim-123',
  ADMIN_PASSWORD_HASH: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
};

describe('leesEnv', () => {
  it('geeft alle velden terug bij een volledige bron', () => {
    const env = leesEnv(volledig);
    assert.equal(env.unipileDsn, 'api68.unipile.com:19841');
    assert.equal(env.unipileApiKey, 'geheime-sleutel-abc');
    assert.equal(env.webhookSecret, 'webhook-geheim-xyz');
    assert.equal(env.mcpToken, 'mcp-geheim-123');
    assert.equal(env.adminPasswordHash, 'scrypt$16384$8$1$c2FsdA==$aGFzaA==');
    assert.equal(env.databaseUrl, 'postgres://user:pass@host:5432/db');
  });

  it('eist een MCP_TOKEN en noemt de naam in de fout', () => {
    const { MCP_TOKEN: _weg, ...zonder } = volledig;
    assert.throws(
      () => leesEnv(zonder),
      (err: Error) => {
        assert.match(err.message, /MCP_TOKEN/);
        assert.match(err.message, /ontbreek/i);
        return true;
      },
    );
  });

  it('lekt de MCP_TOKEN niet in een foutmelding', () => {
    try {
      leesEnv({ ...volledig, DATABASE_URL: '' });
      assert.fail('leesEnv had moeten falen bij een lege DATABASE_URL');
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /mcp-geheim-123/);
    }
  });

  it('vult standaardwaarden in voor optionele velden', () => {
    const env = leesEnv(volledig);
    assert.equal(env.port, 3000);
    assert.equal(env.logLevel, 'info');
    assert.equal(env.timezoneDefault, 'Europe/Amsterdam');
    assert.equal(env.nodeEnv, 'development');
  });

  it('respecteert opgegeven optionele waarden', () => {
    const env = leesEnv({
      ...volledig,
      PORT: '8080',
      LOG_LEVEL: 'debug',
      TIMEZONE_DEFAULT: 'Europe/Berlin',
      NODE_ENV: 'production',
    });
    assert.equal(env.port, 8080);
    assert.equal(env.logLevel, 'debug');
    assert.equal(env.timezoneDefault, 'Europe/Berlin');
    assert.equal(env.nodeEnv, 'production');
  });

  it('gooit een Nederlandse fout die de naam noemt bij een ontbrekende sleutel', () => {
    const { UNIPILE_API_KEY: _weg, ...zonder } = volledig;
    assert.throws(
      () => leesEnv(zonder),
      (err: Error) => {
        assert.match(err.message, /UNIPILE_API_KEY/);
        assert.match(err.message, /ontbreek/i);
        return true;
      },
    );
  });

  it('lekt geen geheime waarden in de foutmelding', () => {
    try {
      leesEnv({ ...volledig, DATABASE_URL: '' });
      assert.fail('leesEnv had moeten falen bij een lege DATABASE_URL');
    } catch (err) {
      const bericht = (err as Error).message;
      assert.doesNotMatch(bericht, /geheime-sleutel-abc/);
      assert.doesNotMatch(bericht, /webhook-geheim-xyz/);
      assert.doesNotMatch(bericht, /user:pass/);
    }
  });

  it('weigert een ongeldig LOG_LEVEL met een Nederlandse fout', () => {
    assert.throws(
      () => leesEnv({ ...volledig, LOG_LEVEL: 'schreeuwen' }),
      (err: Error) => {
        assert.match(err.message, /LOG_LEVEL/);
        assert.match(err.message, /debug|info|warn|error/);
        return true;
      },
    );
  });

  it('weigert een niet-numerieke PORT met een Nederlandse fout', () => {
    assert.throws(
      () => leesEnv({ ...volledig, PORT: 'drieduizend' }),
      (err: Error) => {
        assert.match(err.message, /PORT/);
        assert.match(err.message, /getal/i);
        return true;
      },
    );
  });
});
