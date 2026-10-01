import type { Klok } from '../budget/klok.ts';
import type { Tijdvenster } from '../budget/limits.ts';
import { binnenWerkuren, isWerkdag } from '../budget/tijdvenster.ts';
import type { Logger } from '../log/logger.ts';

import type { PauzeKiezer } from './pauze.ts';

/**
 * Planner-lus voor productie (fase 3 ronde 4). Draait alleen als
 * `PLANNER_ENABLED=true`; anders wordt er geen enkele timer gezet.
 *
 * Ritme: geen vaste klokslagen. Na elke tick kiest de lus een willekeurige
 * wachttijd binnen `tijdvenster.pauze_tussen_acties_minuten` (config/limits.json)
 * en wordt alleen binnen de werktijden (werkdagen + start/einde in de
 * standaard-tijdzone) daadwerkelijk getickt. Buiten werktijd slaat de lus de
 * tick over en kijkt na een nieuwe willekeurige pauze opnieuw. De budgetmotor
 * blijft per account zelf het tijdvenster bewaken; dit is een extra rem.
 *
 * Meldt de tick `gatewayGestopt` (onze Unipile-sleutel geweigerd), dan stopt
 * de lus volledig tot een herstart — Rubert moet eerst kijken.
 */

export interface TickUitkomst {
  gatewayGestopt: boolean;
}

export interface Timers {
  zet(fn: () => void, ms: number): unknown;
  wis(handvat: unknown): void;
}

export const systeemTimers: Timers = {
  zet: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  wis: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PlannerLusDeps {
  ingeschakeld: boolean;
  tick: () => Promise<TickUitkomst>;
  tijdvenster: Tijdvenster;
  tijdzone: string;
  klok: Klok;
  pauzeKiezer: PauzeKiezer;
  logger: Logger;
  timers?: Timers;
}

export interface PlannerLus {
  readonly actief: boolean;
  /** Stopt de lus en wacht tot een lopende tick klaar is. */
  stop(): Promise<void>;
}

export function startPlannerLus(deps: PlannerLusDeps): PlannerLus {
  if (!deps.ingeschakeld) {
    deps.logger.info('Planner staat uit (PLANNER_ENABLED is niet "true"); er worden geen acties verwerkt.');
    return { actief: false, stop: async () => {} };
  }

  const timers = deps.timers ?? systeemTimers;
  let gestopt = false;
  let handvat: unknown = null;
  let lopend: Promise<void> | null = null;

  const plan = (): void => {
    if (gestopt) return;
    const seconden = deps.pauzeKiezer.kies(deps.tijdvenster.pauze_tussen_acties_minuten);
    deps.logger.debug('Volgende planner-tick gepland', { over_seconden: seconden });
    handvat = timers.zet(() => {
      handvat = null;
      lopend = draai().finally(() => {
        lopend = null;
      });
    }, seconden * 1000);
  };

  const draai = async (): Promise<void> => {
    if (gestopt) return;
    const nu = deps.klok.nu();
    const tv = deps.tijdvenster;
    const inWerktijd =
      isWerkdag(nu, deps.tijdzone, tv.werkdagen) &&
      binnenWerkuren(nu, deps.tijdzone, tv.start_lokaal, tv.einde_lokaal);
    if (inWerktijd) {
      try {
        const uitkomst = await deps.tick();
        if (uitkomst.gatewayGestopt) {
          deps.logger.error(
            'Planner gestopt: Unipile weigert de gateway-API-sleutel. Controleer UNIPILE_API_KEY en herstart daarna de dienst.',
          );
          gestopt = true;
          return;
        }
      } catch (err) {
        deps.logger.error('Planner-tick mislukt; volgende poging na de gewone pauze.', { fout: err });
      }
    }
    plan();
  };

  deps.logger.info('Planner staat aan; ticks op willekeurige momenten binnen werktijd.', {
    tijdzone: deps.tijdzone,
    werktijd: `${deps.tijdvenster.start_lokaal}-${deps.tijdvenster.einde_lokaal}`,
  });
  plan();

  return {
    get actief() {
      return !gestopt;
    },
    async stop() {
      gestopt = true;
      if (handvat !== null) timers.wis(handvat);
      handvat = null;
      if (lopend) await lopend;
    },
  };
}
