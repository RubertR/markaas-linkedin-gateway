/**
 * Startpunt van de gateway (`npm start`). Eén proces met:
 * - de hono-server: `/health`, `/webhooks/*`, `/mcp`, `/admin/*`, `/koppelen/*`;
 * - de planner-lus, alleen als `PLANNER_ENABLED=true` (standaard uit).
 *
 * Draait géén migraties; die blijven een bewuste handmatige stap
 * (`npm run migrate`).
 */

import { serve } from '@hono/node-server';

import { systeemKlok } from './budget/klok.ts';
import { laadLimieten } from './budget/limits.ts';
import { verwerkVerzoekenSyncTick } from './budget/verzoekensync.ts';
import { laadAbonnementConfig } from './config/abonnement.ts';
import { EnvFout, leesEnv, type Env } from './config/env.ts';
import { laadJuridisch } from './config/juridisch.ts';
import { postgresBackend } from './db/postgres-backend.ts';
import { maakLogger, type Logger } from './log/logger.ts';
import { startPlannerLus } from './queue/lus.ts';
import { systeemRandom } from './queue/pauze.ts';
import { voerPlannerTickUit } from './queue/planner.ts';
import { maakReconnectLink } from './register/koppelflow.ts';
import { verwerkSequentieTick } from './sequences/motor.ts';
import { systeemWerkdagenKiezer } from './sequences/wachttijd.ts';
import { maakGatewayApp, unipileBaseUrl } from './server/app.ts';
import { leesVersie } from './server/versie.ts';
import { maakUnipileClient } from './unipile/client.ts';
import { koppelNotifyUrl, koppelSleutel } from './webhooks/geheim.ts';

function geheimenUit(env: Env): string[] {
  return [
    env.unipileApiKey,
    env.webhookSecret,
    koppelSleutel(env.webhookSecret),
    env.mcpToken,
    env.adminPasswordHash,
    env.databaseUrl,
    ...(env.stripe ? [env.stripe.secretKey, env.stripe.webhookSecret] : []),
  ];
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = leesEnv();
  } catch (err) {
    if (err instanceof EnvFout) {
      // Logger bestaat nog niet (LOG_LEVEL kan zelf fout zijn); schrijf direct
      // JSON. Meldingen bevatten alleen namen van variabelen, nooit waarden.
      for (const melding of err.meldingen) {
        process.stderr.write(
          `${JSON.stringify({ tijd: new Date().toISOString(), niveau: 'error', bericht: melding })}\n`,
        );
      }
      process.stderr.write(
        `${JSON.stringify({
          tijd: new Date().toISOString(),
          niveau: 'error',
          bericht: `Gateway start niet: ${err.meldingen.length} probleem/problemen met omgevingsvariabelen. Vul ze aan en start opnieuw.`,
        })}\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  const logger = maakLogger({ niveau: env.logLevel, geheimen: geheimenUit(env) });
  const versie = leesVersie();
  const limieten = await laadLimieten();
  const juridisch = await laadJuridisch();
  const abonnement = await laadAbonnementConfig();
  const db = postgresBackend({ databaseUrl: env.databaseUrl });
  const baseUrl = unipileBaseUrl(env.unipileDsn);
  const unipile = maakUnipileClient({ baseUrl, apiKey: env.unipileApiKey });
  const klok = systeemKlok;

  const app = maakGatewayApp({
    env,
    db,
    unipile,
    limieten,
    juridisch,
    klok,
    pauzeKiezer: systeemRandom,
    werkdagen: systeemWerkdagenKiezer,
    logger,
    versie,
    abonnement,
  });

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    logger.info('Gateway gestart', {
      versie,
      poort: info.port,
      omgeving: env.nodeEnv,
      planner: env.plannerEnabled ? 'aan' : 'uit',
      publieke_url: env.publicBaseUrl,
      stripe: env.stripe ? 'aan' : 'uit',
    });
    if (env.stripeOntbrekend.length > 0) {
      logger.warn(
        `Stripe staat uit: ${env.stripeOntbrekend.join(', ')} ontbreekt. Zet alle drie de STRIPE_*-variabelen (zie README, "Stripe inrichten").`,
      );
    }
    if (env.nodeEnv === 'production' && env.publicBaseUrl.startsWith('http://localhost')) {
      logger.warn(
        'Geen publieke URL bekend: koppellinks krijgen een localhost-notify_url. Zet PUBLIC_BASE_URL of genereer een Railway-domein.',
      );
    }
  });

  const koppelOpties = {
    notifyUrl: koppelNotifyUrl(env.publicBaseUrl, env.webhookSecret),
    apiUrl: baseUrl,
  };
  const lus = startPlannerLus({
    ingeschakeld: env.plannerEnabled,
    tijdvenster: limieten.tijdvenster,
    tijdzone: env.timezoneDefault,
    klok,
    pauzeKiezer: systeemRandom,
    logger,
    tick: async () => {
      // Eerst de teller gelijkzetten, zodat de budgetmotor met verse cijfers werkt.
      const verzoeken = await verwerkVerzoekenSyncTick({ db, unipile, limieten, klok });
      logVerzoekenSync(logger, verzoeken);
      if (verzoeken.gatewayGestopt) return { gatewayGestopt: true };
      const sequenties = await verwerkSequentieTick({
        db,
        klok,
        limieten,
        werkdagen: systeemWerkdagenKiezer,
      });
      const planner = await voerPlannerTickUit({
        db,
        unipile,
        limieten,
        klok,
        pauzeKiezer: systeemRandom,
        reconnectHook: async (accountId) => {
          await maakReconnectLink(db, unipile, koppelOpties, accountId);
        },
      });
      logTick(logger, sequenties, planner);
      return { gatewayGestopt: planner.gatewayGestopt };
    },
  });

  let bezigMetStoppen = false;
  const stop = async (signaal: string): Promise<void> => {
    if (bezigMetStoppen) return;
    bezigMetStoppen = true;
    logger.info('Gateway stopt', { signaal });
    await lus.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

function logVerzoekenSync(
  logger: Logger,
  uitkomst: Awaited<ReturnType<typeof verwerkVerzoekenSyncTick>>,
): void {
  for (const r of uitkomst.resultaten) {
    const velden = {
      account_id: r.accountId,
      resultaat: r.resultaat,
      voor: r.voor,
      werkelijk: r.werkelijk,
      reden: r.reden,
    };
    if (r.resultaat === 'gelijkgezet') logger.info('Openstaande verzoeken gesynct', velden);
    else logger.warn('Sync openstaande verzoeken mislukt', velden);
  }
}

function logTick(
  logger: Logger,
  sequenties: Awaited<ReturnType<typeof verwerkSequentieTick>>,
  planner: Awaited<ReturnType<typeof voerPlannerTickUit>>,
): void {
  logger.info('Planner-tick klaar', {
    acties_verwerkt: planner.verwerkt,
    resultaten: planner.details.map((d) => ({
      actie_id: d.actieId,
      account_id: d.accountId,
      type: d.type,
      resultaat: d.resultaat,
    })),
    sequenties: {
      verlopen: sequenties.verlopen.length,
      stap2: sequenties.stap2Aangemaakt.length,
      stap3: sequenties.stap3Aangemaakt.length,
      afgerond: sequenties.afgerond.length,
      overgeslagen: sequenties.overgeslagenDoorAccount.length,
    },
  });
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  // Geen logger beschikbaar met geheimenlijst; DATABASE_URL e.d. kunnen in een
  // driverfout staan, dus poets bekende waarden uit de omgeving weg.
  const geheimen = [
    process.env['UNIPILE_API_KEY'],
    process.env['WEBHOOK_SECRET'],
    process.env['MCP_TOKEN'],
    process.env['ADMIN_PASSWORD_HASH'],
    process.env['DATABASE_URL'],
    process.env['STRIPE_SECRET_KEY'],
    process.env['STRIPE_WEBHOOK_SECRET'],
  ];
  const veilig = maakLogger({
    niveau: 'error',
    geheimen: geheimen.filter((g): g is string => typeof g === 'string'),
    schrijf: (r) => process.stderr.write(`${r}\n`),
  });
  veilig.error(`Gateway kon niet starten: ${bericht}`);
  process.exit(1);
});
