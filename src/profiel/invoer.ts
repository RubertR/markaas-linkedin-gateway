import type { Intake, IntakeRonde, IntakeVraag } from '../config/intake.ts';

/**
 * Formulierinvoer van de klantprofiel-intake (SPEC §14.6) omzetten naar
 * antwoorden, controleren en samenvatten. Puur: geen database.
 *
 * Veldnamen in het formulier:
 * - `v_<id>`: tekst, of de gekozen optie(s);
 * - `v_<id>_anders`: "Anders, namelijk …";
 * - `v_<id>_tekst_<n>` en `v_<id>_ok_<n>`: claim n en het vinkje.
 */

export const MAX_TEKST = 1000;
export const MAX_ANDERS = 300;
export const MAX_CLAIM = 300;
/** Waarde van de radioknop "Anders" bij een enkele keuze. */
export const ANDERS_WAARDE = '__anders__';

export interface Claim {
  tekst: string;
  /** Opgeslagen claims zijn altijd bevestigd; `false` komt alleen voor in `weergave`. */
  bevestigd: boolean;
}

export interface Antwoord {
  tekst?: string;
  keuzes?: string[];
  anders?: string;
  claims?: Claim[];
}

export type Antwoorden = Record<string, Antwoord>;

export interface RondeInvoer {
  /** Om op te slaan: alleen bevestigde claims. */
  antwoorden: Antwoorden;
  /** Om terug te tonen bij een fout: ook claims zonder vinkje. */
  weergave: Antwoorden;
  fouten: string[];
}

export function leesRondeUitFormulier(ronde: IntakeRonde, form: Record<string, unknown>): RondeInvoer {
  const antwoorden: Antwoorden = {};
  const weergave: Antwoorden = {};
  const fouten: string[] = [];
  for (const vraag of ronde.vragen) {
    const veld = `v_${vraag.id}`;
    switch (vraag.type) {
      case 'tekst': {
        const t = schoon(eerste(form[veld]), MAX_TEKST);
        antwoorden[vraag.id] = t ? { tekst: t } : {};
        break;
      }
      case 'keuze':
      case 'keuzes': {
        const gekozen = alle(form[veld]);
        const keuzes = vraag.opties.filter((o) => gekozen.includes(o));
        const antwoord: Antwoord = {};
        if (vraag.type === 'keuze') {
          if (keuzes.length > 0) antwoord.keuzes = [keuzes[0]!];
        } else if (keuzes.length > 0) {
          antwoord.keuzes = keuzes;
        }
        if (vraag.anders) {
          const anders = schoon(eerste(form[`${veld}_anders`]), MAX_ANDERS);
          // Bij een enkele keuze telt "anders" alleen als die knop gekozen is.
          const andersGekozen = vraag.type === 'keuzes' || gekozen.includes(ANDERS_WAARDE);
          if (anders && andersGekozen) {
            antwoord.anders = anders;
            if (vraag.type === 'keuze') antwoord.keuzes = [];
          }
        }
        antwoorden[vraag.id] = antwoord;
        break;
      }
      case 'claims': {
        const claims: Claim[] = [];
        const alle: Claim[] = [];
        let zonderVinkje = 0;
        for (let n = 1; n <= vraag.maxClaims; n += 1) {
          const t = schoon(eerste(form[`${veld}_tekst_${n}`]), MAX_CLAIM);
          if (!t) continue;
          const bevestigd = Boolean(eerste(form[`${veld}_ok_${n}`]));
          alle.push({ tekst: t, bevestigd });
          if (bevestigd) claims.push({ tekst: t, bevestigd: true });
          else zonderVinkje += 1;
        }
        weergave[vraag.id] = alle.length > 0 ? { claims: alle } : {};
        if (zonderVinkje > 0) {
          fouten.push(
            `Bevestig elke ingevulde claim met het vinkje "Dit klopt en mag in berichten gebruikt worden", of maak het veld leeg (${zonderVinkje} zonder vinkje).`,
          );
        }
        antwoorden[vraag.id] = claims.length > 0 ? { claims } : {};
        break;
      }
    }
    if (!(vraag.id in weergave)) weergave[vraag.id] = antwoorden[vraag.id]!;
  }
  return { antwoorden, weergave, fouten };
}

export function isBeantwoord(vraag: IntakeVraag, a: Antwoord | undefined): boolean {
  if (!a) return false;
  switch (vraag.type) {
    case 'tekst':
      return Boolean(a.tekst);
    case 'keuze':
    case 'keuzes':
      return (a.keuzes?.length ?? 0) > 0 || Boolean(a.anders);
    case 'claims':
      return (a.claims?.some((c) => c.bevestigd) ?? false);
  }
}

/** Verplichte vragen zonder antwoord, als "Ronde: vraag". */
export function ontbrekendeVerplichte(intake: Intake, antwoorden: Antwoorden): string[] {
  const uit: string[] = [];
  for (const ronde of intake.rondes) {
    for (const vraag of ronde.vragen) {
      if (vraag.verplicht && !isBeantwoord(vraag, antwoorden[vraag.id])) uit.push(`${ronde.titel}: ${vraag.label}`);
    }
  }
  return uit;
}

export interface SamenvattingRegel {
  vraagId: string;
  label: string;
  /** Leesbaar antwoord; leeg = niet beantwoord. Claims gescheiden door een nieuwe regel. */
  waarde: string;
}

export interface SamenvattingRonde {
  rondeId: string;
  titel: string;
  regels: SamenvattingRegel[];
}

export function samenvatting(intake: Intake, antwoorden: Antwoorden): SamenvattingRonde[] {
  return intake.rondes.map((ronde) => ({
    rondeId: ronde.id,
    titel: ronde.titel,
    regels: ronde.vragen.map((vraag) => ({
      vraagId: vraag.id,
      label: vraag.label,
      waarde: leesbaar(antwoorden[vraag.id]),
    })),
  }));
}

function leesbaar(a: Antwoord | undefined): string {
  if (!a) return '';
  if (a.claims) return a.claims.filter((c) => c.bevestigd).map((c) => c.tekst).join('\n');
  if (a.tekst) return a.tekst;
  const delen = [...(a.keuzes ?? [])];
  const keuzes = delen.join(', ');
  if (a.anders) return keuzes ? `${keuzes}; anders: ${a.anders}` : a.anders;
  return keuzes;
}

/** Alleen de antwoorden van vragen die (nog) in de intake staan, voor opslag. */
export function alleenBekendeVragen(intake: Intake, antwoorden: Antwoorden): Antwoorden {
  const ids = new Set(intake.rondes.flatMap((r) => r.vragen.map((v) => v.id)));
  return Object.fromEntries(Object.entries(antwoorden).filter(([id]) => ids.has(id)));
}

function eerste(w: unknown): string {
  if (typeof w === 'string') return w;
  if (Array.isArray(w) && typeof w[0] === 'string') return w[0];
  return '';
}

function alle(w: unknown): string[] {
  if (typeof w === 'string') return [w];
  if (Array.isArray(w)) return w.filter((x): x is string => typeof x === 'string');
  return [];
}

function schoon(w: string, max: number): string {
  return w.replace(/\r\n/g, '\n').trim().slice(0, max);
}
