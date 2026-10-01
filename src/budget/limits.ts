import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Abonnement } from '../register/accounts.ts';

export type ActieType = 'search' | 'profile' | 'invite' | 'message' | 'inmail';

export interface NotitieLimiet {
  toegestaan: boolean;
  tekens_max?: number;
  per_maand?: number;
}

export interface BonusNaOpbouw {
  min_weken_opbouw: number;
  acceptatie_drempel: number;
  week_maximum: number;
}

export interface InviteLimiet {
  dag: number;
  week: number;
  openstaand_maximum: number;
  notitie: NotitieLimiet;
  bonus_na_opbouw?: BonusNaOpbouw;
}

export interface MessageLimiet {
  dag: number;
  week: number;
}

export interface InmailLimiet {
  maand: number;
  credit_terug_bij_antwoord_binnen_dagen?: number;
}

export interface SearchLimiet {
  resultaten_per_dag: number;
  runs_per_dag: number;
}

export interface ProfileLimiet {
  dag: number;
  week: number;
}

export interface AbonnementLimieten {
  invite: InviteLimiet;
  message: MessageLimiet;
  inmail: InmailLimiet;
  search: SearchLimiet;
  profile: ProfileLimiet;
}

export interface Opbouw {
  start_factor: number;
  stap_per_week: number;
  maximum: number;
  acceptatie_drempel: number;
  acceptatie_venster_dagen: number;
}

export interface Afkoeling {
  duur_uren: number;
  opbouw_factor_na: number;
  opbouw_periode_dagen: number;
  triggers: readonly string[];
}

export interface PauzeGrensSeconden {
  min: number;
  max: number;
}

export interface Tijdvenster {
  werkdagen: readonly number[];
  start_lokaal: string;
  einde_lokaal: string;
  pauze_tussen_acties_minuten: { min: number; max: number };
  pauze_mcp_sync_seconden: {
    profile: PauzeGrensSeconden;
    search: PauzeGrensSeconden;
  };
  tijdzone_standaard: string;
}

export interface UnipileSignaal {
  afremmen_bij_percentage: number;
  nieuwe_factor_bij_afremmen: number;
}

export interface TekstMaxTekens {
  invite: number;
  message: number;
  inmail: number;
}

export interface WerkdagenBereik {
  min: number;
  max: number;
}

export interface SequentieStopRedenen {
  reactie: string;
  niet_geaccepteerd: string;
  voltooid: string;
}

export interface SequentieLimieten {
  wachttijden_werkdagen: {
    eerste_bericht_na_acceptatie: WerkdagenBereik;
    opvolging_na_eerste_bericht: WerkdagenBereik;
  };
  verzoek_vervalt_na_dagen: number;
  stop_redenen: SequentieStopRedenen;
}

export interface Limieten {
  opbouw: Opbouw;
  afkoeling: Afkoeling;
  tijdvenster: Tijdvenster;
  tekst_max_tekens: TekstMaxTekens;
  sequenties: SequentieLimieten;
  unipile_usage_signaal: UnipileSignaal;
  abonnementen: Record<Abonnement, AbonnementLimieten>;
}

const VERPLICHTE_ABONNEMENTEN: readonly Abonnement[] = [
  'free',
  'premium_career',
  'premium_business',
  'salesnav_core',
  'salesnav_advanced',
];

const HIER = dirname(fileURLToPath(import.meta.url));
const STANDAARD_PAD = join(HIER, '..', '..', 'config', 'limits.json');

export async function laadLimieten(pad: string = STANDAARD_PAD): Promise<Limieten> {
  const inhoud = await readFile(pad, 'utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(inhoud);
  } catch (err) {
    throw new Error(
      `config/limits.json kan niet gelezen worden als JSON (${(err as Error).message}).`,
    );
  }
  return limietenUitObject(obj);
}

export function limietenUitObject(obj: unknown): Limieten {
  if (!isRecord(obj)) {
    throw new Error('Limieten-configuratie moet een object zijn.');
  }

  const opbouw = parseOpbouw(obj['opbouw']);
  const afkoeling = parseAfkoeling(obj['afkoeling']);
  const tijdvenster = parseTijdvenster(obj['tijdvenster']);
  const tekst_max_tekens = parseTekstMax(obj['tekst_max_tekens']);
  const sequenties = parseSequenties(obj['sequenties']);
  const unipile_usage_signaal = parseUnipileSignaal(obj['unipile_usage_signaal']);

  const bronAbonnementen = obj['abonnementen'];
  if (!isRecord(bronAbonnementen)) {
    throw new Error('Veld "abonnementen" ontbreekt in limieten-configuratie.');
  }
  const ontbrekend = VERPLICHTE_ABONNEMENTEN.filter((naam) => !isRecord(bronAbonnementen[naam]));
  if (ontbrekend.length > 0) {
    throw new Error(
      `Abonnement ${ontbrekend.map((n) => `"${n}"`).join(', ')} ontbreekt in limieten-configuratie; verwacht zijn ${VERPLICHTE_ABONNEMENTEN.join(', ')}.`,
    );
  }
  const abonnementen = {} as Record<Abonnement, AbonnementLimieten>;
  for (const naam of VERPLICHTE_ABONNEMENTEN) {
    abonnementen[naam] = parseAbonnement(naam, bronAbonnementen[naam] as Record<string, unknown>);
  }

  return {
    opbouw,
    afkoeling,
    tijdvenster,
    tekst_max_tekens,
    sequenties,
    unipile_usage_signaal,
    abonnementen,
  };
}

function parseSequenties(raw: unknown): SequentieLimieten {
  if (!isRecord(raw)) {
    throw new Error('Veld "sequenties" ontbreekt in limieten-configuratie.');
  }
  const wacht = raw['wachttijden_werkdagen'];
  if (!isRecord(wacht)) {
    throw new Error('Veld "sequenties.wachttijden_werkdagen" ontbreekt.');
  }
  const eerste = wacht['eerste_bericht_na_acceptatie'];
  const opvolg = wacht['opvolging_na_eerste_bericht'];
  if (!isRecord(eerste) || !isRecord(opvolg)) {
    throw new Error(
      'Velden "sequenties.wachttijden_werkdagen.eerste_bericht_na_acceptatie" en "...opvolging_na_eerste_bericht" moeten elk {min, max} bevatten.',
    );
  }
  const stop = raw['stop_redenen'];
  if (!isRecord(stop)) {
    throw new Error('Veld "sequenties.stop_redenen" ontbreekt.');
  }
  return {
    wachttijden_werkdagen: {
      eerste_bericht_na_acceptatie: {
        min: positiefGetal(eerste, 'min'),
        max: positiefGetal(eerste, 'max'),
      },
      opvolging_na_eerste_bericht: {
        min: positiefGetal(opvolg, 'min'),
        max: positiefGetal(opvolg, 'max'),
      },
    },
    verzoek_vervalt_na_dagen: positiefGetal(raw, 'verzoek_vervalt_na_dagen'),
    stop_redenen: {
      reactie: tekst(stop, 'reactie'),
      niet_geaccepteerd: tekst(stop, 'niet_geaccepteerd'),
      voltooid: tekst(stop, 'voltooid'),
    },
  };
}

function parseTekstMax(raw: unknown): TekstMaxTekens {
  if (!isRecord(raw)) {
    throw new Error('Veld "tekst_max_tekens" ontbreekt in limieten-configuratie.');
  }
  return {
    invite: positiefGetal(raw, 'invite'),
    message: positiefGetal(raw, 'message'),
    inmail: positiefGetal(raw, 'inmail'),
  };
}

function parseOpbouw(raw: unknown): Opbouw {
  if (!isRecord(raw)) throw new Error('Veld "opbouw" ontbreekt in limieten-configuratie.');
  const start_factor = getalInBereik(raw, 'start_factor', 0.5, 1.0);
  const stap_per_week = positiefGetal(raw, 'stap_per_week');
  const maximum = getalInBereik(raw, 'maximum', 0.5, 1.0);
  const acceptatie_drempel = getalInBereik(raw, 'acceptatie_drempel', 0, 1);
  const acceptatie_venster_dagen = positiefGetal(raw, 'acceptatie_venster_dagen');
  return { start_factor, stap_per_week, maximum, acceptatie_drempel, acceptatie_venster_dagen };
}

function parseAfkoeling(raw: unknown): Afkoeling {
  if (!isRecord(raw)) throw new Error('Veld "afkoeling" ontbreekt in limieten-configuratie.');
  return {
    duur_uren: positiefGetal(raw, 'duur_uren'),
    opbouw_factor_na: getalInBereik(raw, 'opbouw_factor_na', 0.5, 1.0),
    opbouw_periode_dagen: positiefGetal(raw, 'opbouw_periode_dagen'),
    triggers: Array.isArray(raw['triggers']) ? (raw['triggers'] as string[]) : [],
  };
}

function parseTijdvenster(raw: unknown): Tijdvenster {
  if (!isRecord(raw)) throw new Error('Veld "tijdvenster" ontbreekt in limieten-configuratie.');
  const werkdagen = Array.isArray(raw['werkdagen']) ? (raw['werkdagen'] as number[]) : [];
  const pauze = raw['pauze_tussen_acties_minuten'];
  if (!isRecord(pauze)) {
    throw new Error('Veld "pauze_tussen_acties_minuten" ontbreekt in tijdvenster.');
  }
  const sync = raw['pauze_mcp_sync_seconden'];
  if (!isRecord(sync)) {
    throw new Error('Veld "pauze_mcp_sync_seconden" ontbreekt in tijdvenster.');
  }
  const syncProfile = sync['profile'];
  const syncSearch = sync['search'];
  if (!isRecord(syncProfile) || !isRecord(syncSearch)) {
    throw new Error(
      'Veld "pauze_mcp_sync_seconden" vereist "profile" en "search" (elk met min en max).',
    );
  }
  return {
    werkdagen,
    start_lokaal: tekst(raw, 'start_lokaal'),
    einde_lokaal: tekst(raw, 'einde_lokaal'),
    pauze_tussen_acties_minuten: {
      min: positiefGetal(pauze, 'min'),
      max: positiefGetal(pauze, 'max'),
    },
    pauze_mcp_sync_seconden: {
      profile: {
        min: positiefGetal(syncProfile, 'min'),
        max: positiefGetal(syncProfile, 'max'),
      },
      search: {
        min: positiefGetal(syncSearch, 'min'),
        max: positiefGetal(syncSearch, 'max'),
      },
    },
    tijdzone_standaard: tekst(raw, 'tijdzone_standaard'),
  };
}

function parseUnipileSignaal(raw: unknown): UnipileSignaal {
  if (!isRecord(raw)) {
    throw new Error('Veld "unipile_usage_signaal" ontbreekt in limieten-configuratie.');
  }
  return {
    afremmen_bij_percentage: positiefGetal(raw, 'afremmen_bij_percentage'),
    nieuwe_factor_bij_afremmen: getalInBereik(raw, 'nieuwe_factor_bij_afremmen', 0.5, 1.0),
  };
}

function parseAbonnement(naam: Abonnement, raw: Record<string, unknown>): AbonnementLimieten {
  const invite = raw['invite'];
  if (!isRecord(invite)) {
    throw new Error(`Actietype "invite" ontbreekt in abonnement ${naam}.`);
  }
  const notitieRaw = invite['notitie'];
  if (!isRecord(notitieRaw)) {
    throw new Error(`Veld "notitie" ontbreekt in abonnement ${naam}.invite.`);
  }
  const notitie: NotitieLimiet = { toegestaan: Boolean(notitieRaw['toegestaan']) };
  if (typeof notitieRaw['tekens_max'] === 'number') notitie.tekens_max = notitieRaw['tekens_max'];
  if (typeof notitieRaw['per_maand'] === 'number') notitie.per_maand = notitieRaw['per_maand'];

  const inviteOut: InviteLimiet = {
    dag: positiefGetal(invite, 'dag'),
    week: positiefGetal(invite, 'week'),
    openstaand_maximum: positiefGetal(invite, 'openstaand_maximum'),
    notitie,
  };
  if (isRecord(invite['bonus_na_opbouw'])) {
    const b = invite['bonus_na_opbouw'];
    inviteOut.bonus_na_opbouw = {
      min_weken_opbouw: positiefGetal(b, 'min_weken_opbouw'),
      acceptatie_drempel: getalInBereik(b, 'acceptatie_drempel', 0, 1),
      week_maximum: positiefGetal(b, 'week_maximum'),
    };
  }

  const message = raw['message'];
  if (!isRecord(message)) throw new Error(`Actietype "message" ontbreekt in abonnement ${naam}.`);
  const inmail = raw['inmail'];
  if (!isRecord(inmail)) throw new Error(`Actietype "inmail" ontbreekt in abonnement ${naam}.`);
  const search = raw['search'];
  if (!isRecord(search)) throw new Error(`Actietype "search" ontbreekt in abonnement ${naam}.`);
  const profile = raw['profile'];
  if (!isRecord(profile)) throw new Error(`Actietype "profile" ontbreekt in abonnement ${naam}.`);

  const inmailOut: InmailLimiet = { maand: nietNegatiefGetal(inmail, 'maand') };
  if (typeof inmail['credit_terug_bij_antwoord_binnen_dagen'] === 'number') {
    inmailOut.credit_terug_bij_antwoord_binnen_dagen =
      inmail['credit_terug_bij_antwoord_binnen_dagen'];
  }

  return {
    invite: inviteOut,
    message: {
      dag: positiefGetal(message, 'dag'),
      week: positiefGetal(message, 'week'),
    },
    inmail: inmailOut,
    search: {
      resultaten_per_dag: positiefGetal(search, 'resultaten_per_dag'),
      runs_per_dag: positiefGetal(search, 'runs_per_dag'),
    },
    profile: {
      dag: positiefGetal(profile, 'dag'),
      week: positiefGetal(profile, 'week'),
    },
  };
}

function isRecord(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}

function positiefGetal(obj: Record<string, unknown>, veld: string): number {
  const waarde = obj[veld];
  if (typeof waarde !== 'number' || !Number.isFinite(waarde) || waarde <= 0) {
    throw new Error(`Veld "${veld}" moet een positief getal zijn (gaf ${JSON.stringify(waarde)}).`);
  }
  return waarde;
}

function nietNegatiefGetal(obj: Record<string, unknown>, veld: string): number {
  const waarde = obj[veld];
  if (typeof waarde !== 'number' || !Number.isFinite(waarde) || waarde < 0) {
    throw new Error(`Veld "${veld}" moet 0 of hoger zijn (gaf ${JSON.stringify(waarde)}).`);
  }
  return waarde;
}

function getalInBereik(
  obj: Record<string, unknown>,
  veld: string,
  min: number,
  max: number,
): number {
  const waarde = obj[veld];
  if (typeof waarde !== 'number' || !Number.isFinite(waarde) || waarde < min || waarde > max) {
    throw new Error(
      `Veld "${veld}" moet tussen ${min} en ${max} liggen (gaf ${JSON.stringify(waarde)}).`,
    );
  }
  return waarde;
}

function tekst(obj: Record<string, unknown>, veld: string): string {
  const waarde = obj[veld];
  if (typeof waarde !== 'string' || waarde.trim() === '') {
    throw new Error(`Veld "${veld}" moet een niet-lege tekst zijn.`);
  }
  return waarde;
}
