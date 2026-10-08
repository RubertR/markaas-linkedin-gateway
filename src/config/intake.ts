import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vragen van de klantprofiel-intake (SPEC §14.6). Bron: `config/intake.json`,
 * nooit in de code. Elk profiel bewaart de `versie` waarmee het is ingevuld.
 */

export type VraagType = 'tekst' | 'keuze' | 'keuzes' | 'claims';

export interface IntakeVraag {
  id: string;
  type: VraagType;
  label: string;
  verplicht: boolean;
  /** Alleen bij keuze/keuzes. */
  opties: readonly string[];
  /** "Anders, namelijk …" tonen (keuze/keuzes). */
  anders: boolean;
  /** Alleen bij claims: maximaal aantal velden. */
  maxClaims: number;
  /** Toon de gekoppelde LinkedIn-accounts als geheugensteun bij deze vraag. */
  toonAccounts: boolean;
}

export interface IntakeRonde {
  id: string;
  titel: string;
  uitleg: string;
  vragen: readonly IntakeVraag[];
}

export interface Intake {
  versie: string;
  rondes: readonly IntakeRonde[];
}

const HIER = dirname(fileURLToPath(import.meta.url));
const STANDAARD_PAD = join(HIER, '..', '..', 'config', 'intake.json');
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const TYPES: readonly VraagType[] = ['tekst', 'keuze', 'keuzes', 'claims'];

export async function laadIntake(pad: string = STANDAARD_PAD): Promise<Intake> {
  const inhoud = await readFile(pad, 'utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(inhoud);
  } catch (err) {
    throw new Error(`config/intake.json kan niet gelezen worden als JSON (${(err as Error).message}).`);
  }
  return intakeUitObject(obj);
}

export function intakeUitObject(obj: unknown): Intake {
  if (!isRecord(obj)) throw new Error('De intake-configuratie moet een object zijn.');
  const versie = obj['versie'];
  if (typeof versie !== 'string' || versie.trim() === '') {
    throw new Error('Veld "versie" in config/intake.json moet een niet-lege tekst zijn.');
  }
  const ruweRondes = obj['rondes'];
  if (!Array.isArray(ruweRondes) || ruweRondes.length === 0) {
    throw new Error('Veld "rondes" in config/intake.json moet minstens één ronde bevatten.');
  }
  const gezien = new Set<string>();
  const rondes = ruweRondes.map((r, i) => parseRonde(r, i, gezien));
  return { versie: versie.trim(), rondes };
}

function parseRonde(raw: unknown, i: number, gezien: Set<string>): IntakeRonde {
  if (!isRecord(raw)) throw new Error(`Ronde ${i + 1} in config/intake.json moet een object zijn.`);
  const id = parseId(raw['id'], `ronde ${i + 1}`);
  if (gezien.has(`ronde:${id}`)) throw new Error(`Ronde-id "${id}" komt dubbel voor in config/intake.json.`);
  gezien.add(`ronde:${id}`);
  const titel = verplichteTekst(raw['titel'], `ronde "${id}".titel`);
  const uitleg = typeof raw['uitleg'] === 'string' ? raw['uitleg'] : '';
  const vragen = raw['vragen'];
  if (!Array.isArray(vragen) || vragen.length === 0) {
    throw new Error(`Ronde "${id}" in config/intake.json heeft geen vragen.`);
  }
  return { id, titel, uitleg, vragen: vragen.map((v, j) => parseVraag(v, id, j, gezien)) };
}

function parseVraag(raw: unknown, rondeId: string, j: number, gezien: Set<string>): IntakeVraag {
  const plek = `vraag ${j + 1} van ronde "${rondeId}"`;
  if (!isRecord(raw)) throw new Error(`De ${plek} moet een object zijn.`);
  const id = parseId(raw['id'], plek);
  if (gezien.has(`vraag:${id}`)) throw new Error(`Vraag-id "${id}" komt dubbel voor in config/intake.json.`);
  gezien.add(`vraag:${id}`);
  const type = raw['type'];
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
    throw new Error(`Vraag "${id}": onbekend type ${JSON.stringify(type)} (kies uit ${TYPES.join(', ')}).`);
  }
  const vraagType = type as VraagType;
  let opties: string[] = [];
  if (vraagType === 'keuze' || vraagType === 'keuzes') {
    const ruw = raw['opties'];
    if (!Array.isArray(ruw) || ruw.length === 0 || ruw.some((o) => typeof o !== 'string' || o.trim() === '')) {
      throw new Error(`Vraag "${id}": "opties" moet een niet-lege lijst met teksten zijn.`);
    }
    opties = ruw.map((o: string) => o.trim());
    if (new Set(opties).size !== opties.length) throw new Error(`Vraag "${id}": dubbele opties.`);
  }
  const maxClaims = raw['maxClaims'] ?? 5;
  if (typeof maxClaims !== 'number' || !Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > 10) {
    throw new Error(`Vraag "${id}": "maxClaims" moet een geheel getal van 1 tot en met 10 zijn.`);
  }
  return {
    id,
    type: vraagType,
    label: verplichteTekst(raw['label'], `vraag "${id}".label`),
    verplicht: raw['verplicht'] === true,
    opties,
    anders: raw['anders'] === true && (vraagType === 'keuze' || vraagType === 'keuzes'),
    maxClaims,
    toonAccounts: raw['toonAccounts'] === true,
  };
}

function parseId(raw: unknown, plek: string): string {
  if (typeof raw !== 'string' || !ID.test(raw)) {
    throw new Error(
      `Ongeldige id bij ${plek}: gebruik kleine letters, cijfers en _ (begin met een letter), gaf ${JSON.stringify(raw)}.`,
    );
  }
  return raw;
}

function verplichteTekst(raw: unknown, veld: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`Veld ${veld} in config/intake.json moet een niet-lege tekst zijn.`);
  }
  return raw.trim();
}

function isRecord(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}
