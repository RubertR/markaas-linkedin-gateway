/**
 * Tool-definities voor de MCP-server (SPEC §7).
 *
 * Harde regels (CLAUDE.md + SPEC §12):
 * - Geen tool kan een actie goedkeuren, afwijzen of versturen.
 * - `queue_action` plaatst de actie uitsluitend als `draft`; goedkeuring loopt
 *   via de goedkeuringspagina.
 * - `search_people` en `get_profile` lopen via budgetmotor + worker, nooit
 *   rechtstreeks naar Unipile.
 */

export interface ToolDefinitie {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_NAMEN = [
  'list_accounts',
  'account_health',
  'get_budget',
  'search_people',
  'get_profile',
  'queue_action',
  'start_sequence',
  'get_results',
] as const;

export type ToolNaam = (typeof TOOL_NAMEN)[number];

export const TOOL_DEFINITIES: readonly ToolDefinitie[] = [
  {
    name: 'list_accounts',
    description:
      'Lijst LinkedIn-accounts per klant met status, abonnement en opbouw-factor. Verbruikt geen LinkedIn-budget.',
    inputSchema: {
      type: 'object',
      properties: {
        clientSlug: {
          type: 'string',
          description: 'Beperk tot één klant via haar slug. Optioneel.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'account_health',
    description:
      'Sessiestatus, afkoeling en laatste statusbericht van één account. Verbruikt geen LinkedIn-budget.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Interne account-id (UUID).' },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_budget',
    description:
      'Resterend LinkedIn-budget per actietype voor dit account (vandaag en deze week, en maand voor InMail). Verbruikt geen budget.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Interne account-id (UUID).' },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_people',
    description:
      'Zoekopdracht op LinkedIn of Sales Navigator via de budgetmotor + wachtrij-logica. Verbruikt 1 zoekrun uit het dagbudget. Geeft een NL-foutmelding wanneer de budgetmotor weigert of parkeert.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        api: { type: 'string', enum: ['classic', 'sales_navigator'] },
        category: { type: 'string', enum: ['people', 'companies'] },
        keywords: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string' },
        filters: { type: 'object', additionalProperties: true },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_profile',
    description:
      'Haal één LinkedIn-profiel op via de budgetmotor + wachtrij-logica. AVG-velden (contact_info, birthdate) worden standaard weggefilterd. Verbruikt 1 profielbezoek uit het dagbudget.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        identifier: {
          type: 'string',
          description: 'public_identifier of provider_id uit zoekresultaten.',
        },
        secties: {
          type: 'string',
          description: 'LinkedIn sections, standaard "*_preview".',
        },
      },
      required: ['accountId', 'identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'queue_action',
    description:
      'Zet een invite, bericht of InMail in de wachtrij als CONCEPT (status "draft"). Goedkeuring en verzending lopen uitsluitend via de goedkeuringspagina van de gateway — deze tool keurt zelf niets goed en verstuurt niets. De payload MOET altijd ontvanger_naam, ontvanger_functie, ontvanger_bedrijf, ontvanger_url (https linkedin.com) en waarom (reden van de skill) bevatten.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        type: { type: 'string', enum: ['invite', 'message', 'inmail'] },
        payload: {
          type: 'object',
          description:
            'Veldwaarden voor de actie. Technische velden: invite = providerId (+ optioneel message, userEmail); message = chatId, tekst (+ optioneel quoteId); inmail = attendeesIds, tekst (+ optioneel onderwerp, linkedinApi). Voor de goedkeuringspagina altijd verplicht: ontvanger_naam, ontvanger_functie, ontvanger_bedrijf, ontvanger_url (https linkedin.com) en waarom (reden/signaal waarmee de skill deze lead koos).',
          properties: {
            ontvanger_naam: { type: 'string', minLength: 1 },
            ontvanger_functie: { type: 'string', minLength: 1 },
            ontvanger_bedrijf: { type: 'string', minLength: 1 },
            ontvanger_url: {
              type: 'string',
              pattern: '^https://([a-z0-9-]+\\.)?linkedin\\.com/',
            },
            waarom: { type: 'string', minLength: 1 },
          },
          required: [
            'ontvanger_naam',
            'ontvanger_functie',
            'ontvanger_bedrijf',
            'ontvanger_url',
            'waarom',
          ],
          additionalProperties: true,
        },
        geplandOp: {
          type: 'string',
          description: 'Optionele vroegste uitvoerdatum in ISO-8601.',
        },
      },
      required: ['accountId', 'type', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_sequence',
    description:
      'Start een drie-staps-sequentie (verzoek → eerste bericht → opvolging) voor één lead op één account. Maakt uitsluitend het CONCEPT voor stap 1 (invite); stap 2 en 3 worden pas later door de sequentie-tick aangemaakt en lopen ook via de goedkeuringspagina. Deze tool keurt niets goed en verstuurt niets.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Interne account-id (UUID).' },
        lead: {
          type: 'object',
          properties: {
            providerId: { type: 'string', minLength: 1 },
            naam: { type: 'string', minLength: 1 },
            functie: { type: 'string', minLength: 1 },
            bedrijf: { type: 'string', minLength: 1 },
            linkedinUrl: {
              type: 'string',
              pattern: '^https://([a-z0-9-]+\\.)?linkedin\\.com/',
            },
            waarom: { type: 'string', minLength: 1 },
          },
          required: ['providerId', 'naam', 'functie', 'bedrijf', 'linkedinUrl', 'waarom'],
          additionalProperties: false,
        },
        teksten: {
          type: 'object',
          description: 'Teksten voor elke stap. invite = optionele connectienotitie; bericht = eerste bericht na acceptatie; opvolging = opvolging zonder reactie.',
          properties: {
            invite: { type: 'string', minLength: 1 },
            bericht: { type: 'string', minLength: 1 },
            opvolging: { type: 'string', minLength: 1 },
          },
          required: ['invite', 'bericht', 'opvolging'],
          additionalProperties: false,
        },
      },
      required: ['accountId', 'lead', 'teksten'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_results',
    description:
      'Haal recente acties met status (incl. acceptaties en reacties uit de events-tabel) op voor één account of alle accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
];
