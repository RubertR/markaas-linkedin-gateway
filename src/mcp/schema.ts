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
      'Zet een invite, bericht of InMail in de wachtrij als CONCEPT (status "draft"). Goedkeuring en verzending lopen uitsluitend via de goedkeuringspagina van de gateway — deze tool keurt zelf niets goed en verstuurt niets.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        type: { type: 'string', enum: ['invite', 'message', 'inmail'] },
        payload: {
          type: 'object',
          description:
            'Veldwaarden voor de actie. Voor invite: providerId (+ optioneel message, userEmail). Voor message: chatId, tekst (+ optioneel quoteId). Voor inmail: attendeesIds, tekst (+ optioneel onderwerp, linkedinApi).',
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
