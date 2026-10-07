import {
  Unipile422Fout,
  UnipileAccountCredentialsFout,
  UnipileFout,
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
  accountCredentialsCodeUitBody,
  codeUit422Body,
  maak422Fout,
} from './errors.ts';

export interface UnipileOpties {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface UnipileAccount {
  id: string;
  type?: string;
  sources?: Array<{ status: string }>;
  [key: string]: unknown;
}

export interface KoppellinkAanvraag {
  type: 'create' | 'reconnect';
  naam: string;
  notifyUrl: string;
  vervaltOp: Date;
  reconnectAccountId?: string;
  singleUse?: boolean;
  cookieAuthUit?: boolean;
  apiUrl?: string;
  /** Unipile stuurt de browser hierheen na een geslaagde koppeling. */
  successRedirectUrl?: string;
  /** Unipile stuurt de browser hierheen als koppelen mislukt. */
  failureRedirectUrl?: string;
}

export interface Koppellink {
  url: string;
}

export interface ProfielAanvraag {
  accountId: string;
  identifier: string;
  secties?: string;
  filterAvg?: boolean;
}

export type UnipileProfiel = Record<string, unknown> & {
  provider_id?: string;
  public_identifier?: string;
};

export type ZoekApi = 'classic' | 'sales_navigator';
export type ZoekCategorie = 'people' | 'companies';

export interface ZoekAanvraag {
  accountId: string;
  api?: ZoekApi;
  category?: ZoekCategorie;
  keywords?: string;
  limit?: number;
  cursor?: string;
  /**
   * Overige LinkedIn- of Sales-Navigator-filters zoals `company_location`,
   * `industry`, `function`, `seniority`. Zie docs/unipile-notities.md §Zoeken.
   */
  filters?: Record<string, unknown>;
}

export interface ZoekResultaat {
  items: Array<Record<string, unknown>>;
  pagingTotalCount?: number;
  cursor?: string;
}

export interface InviteAanvraag {
  accountId: string;
  providerId: string;
  message?: string;
  userEmail?: string;
}

export interface UsageSignaal {
  percentage: 50 | 75 | 90 | 95;
}

export interface InviteAntwoord {
  invitationId: string;
  usage?: UsageSignaal;
}

export interface VerstuurdeInvitesAanvraag {
  accountId: string;
  /** Items per pagina; Unipile staat 1–250 toe. */
  paginaGrootte: number;
  /** Stopt na zoveel GET's, ook als er nog een cursor is. */
  maxPaginas: number;
}

export interface VerstuurdeInvitesTelling {
  /** Aantal openstaande verstuurde invites in de opgehaalde pagina's. */
  aantal: number;
  /** `false` als er na `maxPaginas` nog een cursor was: `aantal` is dan een ondergrens. */
  volledig: boolean;
  paginas: number;
}

export interface BerichtAanvraag {
  accountId: string;
  chatId: string;
  tekst: string;
  quoteId?: string;
}

export interface BerichtAntwoord {
  messageId: string;
}

export interface GesprekAanvraag {
  accountId: string;
  attendeesIds: string[];
  tekst: string;
  onderwerp?: string;
  linkedinApi?: 'classic' | 'sales_navigator';
  isInmail?: boolean;
}

export interface GesprekAntwoord {
  chatId: string;
  messageId: string;
}

export type WebhookBron = 'account_status' | 'messaging' | 'users';

export interface UnipileWebhook {
  id: string;
  name: string;
  request_url?: string;
  enabled?: boolean;
  events?: string[];
  [key: string]: unknown;
}

export interface WebhookAanvraag {
  naam: string;
  requestUrl: string;
  bron: WebhookBron;
  events: string[];
  /** Eigen headers die Unipile bij elke levering meestuurt (bijv. een geheim). */
  headers?: Record<string, string>;
}

export interface UnipileClient {
  haalAccounts(): Promise<UnipileAccount[]>;
  /** Alle webhooks van deze Unipile-omgeving, alle pagina's. */
  haalWebhooks(): Promise<UnipileWebhook[]>;
  /** Zonder `account_ids`: geldt voor alle huidige én toekomstige accounts. */
  maakWebhook(aanvraag: WebhookAanvraag): Promise<{ webhookId: string }>;
  maakKoppellink(aanvraag: KoppellinkAanvraag): Promise<Koppellink>;
  haalProfiel(aanvraag: ProfielAanvraag): Promise<UnipileProfiel>;
  zoekPersonen(aanvraag: ZoekAanvraag): Promise<ZoekResultaat>;
  stuurInvite(aanvraag: InviteAanvraag): Promise<InviteAntwoord>;
  /**
   * Telt de nog openstaande verstuurde invites (`GET /api/v1/users/invite/sent`).
   * Alleen lezen; geaccepteerde, verlopen en ingetrokken invites staan niet in de lijst.
   */
  telVerstuurdeInvites(aanvraag: VerstuurdeInvitesAanvraag): Promise<VerstuurdeInvitesTelling>;
  stuurBericht(aanvraag: BerichtAanvraag): Promise<BerichtAntwoord>;
  startGesprek(aanvraag: GesprekAanvraag): Promise<GesprekAntwoord>;
}

const STANDAARD_TIMEOUT_MS = 10_000;

export function maakUnipileClient(opties: UnipileOpties): UnipileClient {
  const timeoutMs = opties.timeoutMs ?? STANDAARD_TIMEOUT_MS;

  async function verzoek(
    method: string,
    pad: string,
    init: { json?: unknown; formData?: FormData } = {},
  ): Promise<Response> {
    const endpoint = endpointVan(pad);
    const url = `${opties.baseUrl}${pad}`;
    const headers: Record<string, string> = {
      'X-API-KEY': opties.apiKey,
      Accept: 'application/json',
    };
    let body: string | FormData | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.formData !== undefined) {
      body = init.formData;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const initOptions: RequestInit = { method, headers, signal: ctrl.signal };
      if (body !== undefined) initOptions.body = body;
      return await fetch(url, initOptions);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new UnipileTimeoutFout(endpoint, timeoutMs);
      }
      throw new UnipileTijdelijkeFout(
        `Kon Unipile niet bereiken voor ${endpoint} — probeer over enkele minuten opnieuw.`,
        endpoint,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function ontleed<T = unknown>(
    res: Response,
    pad: string,
    ctx: { accountId?: string } = {},
  ): Promise<T> {
    const endpoint = endpointVan(pad);

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      throw new UnipileTijdelijkeFout(
        `Unipile of LinkedIn vroeg om te vertragen (HTTP 429) op ${endpoint}.`,
        endpoint,
        429,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new UnipileGatewayAuthFout(endpoint, res.status);
    }
    if (res.status >= 400 && res.status < 500) {
      const raw = await res.text();
      const accountCode = accountCredentialsCodeUitBody(raw);
      if (accountCode) {
        throw new UnipileAccountCredentialsFout(accountCode, endpoint, ctx.accountId);
      }
      if (res.status === 422) {
        const code = codeUit422Body(raw) ?? 'onbekend';
        throw maak422Fout(code, endpoint);
      }
      const kort = raw ? `: ${raw.slice(0, 200)}` : '';
      throw new UnipileFout(
        'onverwacht',
        `Onverwacht antwoord van Unipile (HTTP ${res.status}) op ${endpoint}${kort}`,
        endpoint,
        res.status,
      );
    }
    if (res.status >= 500) {
      throw new UnipileTijdelijkeFout(
        `Unipile-serverfout (HTTP ${res.status}) op ${endpoint}.`,
        endpoint,
        res.status,
      );
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  return {
    async haalAccounts() {
      const res = await verzoek('GET', '/api/v1/accounts');
      const body = await ontleed<{ items?: UnipileAccount[] }>(res, '/api/v1/accounts');
      return body.items ?? [];
    },

    async haalWebhooks() {
      const endpoint = '/api/v1/webhooks';
      const alle: UnipileWebhook[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: '250' });
        if (cursor) query.set('cursor', cursor);
        const pad = `${endpoint}?${query.toString()}`;
        const res = await verzoek('GET', pad);
        const body = await ontleed<{ items?: UnipileWebhook[]; cursor?: unknown }>(res, pad);
        alle.push(...(body.items ?? []));
        cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : undefined;
      } while (cursor);
      return alle;
    },

    async maakWebhook(aanvraag) {
      const endpoint = '/api/v1/webhooks';
      const body: Record<string, unknown> = {
        name: aanvraag.naam,
        request_url: aanvraag.requestUrl,
        source: aanvraag.bron,
        events: aanvraag.events,
        format: 'json',
        enabled: true,
      };
      if (aanvraag.headers) {
        body['headers'] = Object.entries(aanvraag.headers).map(([key, value]) => ({ key, value }));
      }
      const res = await verzoek('POST', endpoint, { json: body });
      const parsed = await ontleed<{ webhook_id: string }>(res, endpoint);
      return { webhookId: parsed.webhook_id };
    },

    async maakKoppellink(aanvraag) {
      const endpoint = '/api/v1/hosted/accounts/link';
      const body: Record<string, unknown> = {
        type: aanvraag.type,
        api_url: aanvraag.apiUrl ?? opties.baseUrl,
        expiresOn: aanvraag.vervaltOp.toISOString(),
        disabled_options: aanvraag.cookieAuthUit === false ? [] : ['cookie_auth'],
        name: aanvraag.naam,
        notify_url: aanvraag.notifyUrl,
      };
      if (aanvraag.successRedirectUrl) body['success_redirect_url'] = aanvraag.successRedirectUrl;
      if (aanvraag.failureRedirectUrl) body['failure_redirect_url'] = aanvraag.failureRedirectUrl;
      const ctx: { accountId?: string } = {};
      if (aanvraag.type === 'create') {
        body['providers'] = ['LINKEDIN'];
        body['single_use'] = aanvraag.singleUse !== false;
      } else {
        if (!aanvraag.reconnectAccountId) {
          throw new Error(
            'reconnectAccountId is verplicht bij een koppellink met type "reconnect".',
          );
        }
        body['reconnect_account'] = aanvraag.reconnectAccountId;
        ctx.accountId = aanvraag.reconnectAccountId;
      }
      const res = await verzoek('POST', endpoint, { json: body });
      const parsed = await ontleed<{ url: string }>(res, endpoint, ctx);
      return { url: parsed.url };
    },

    async haalProfiel(aanvraag) {
      const secties = aanvraag.secties ?? '*_preview';
      const query = new URLSearchParams({
        account_id: aanvraag.accountId,
        linkedin_sections: secties,
        notify: 'false',
      });
      const pad = `/api/v1/users/${encodeURIComponent(aanvraag.identifier)}?${query.toString()}`;
      const res = await verzoek('GET', pad);
      const profiel = await ontleed<Record<string, unknown>>(res, pad, {
        accountId: aanvraag.accountId,
      });
      if (aanvraag.filterAvg !== false) {
        delete profiel['contact_info'];
        delete profiel['birthdate'];
      }
      return profiel;
    },

    async zoekPersonen(aanvraag) {
      const query = new URLSearchParams({ account_id: aanvraag.accountId });
      if (aanvraag.limit !== undefined) query.set('limit', String(aanvraag.limit));
      if (aanvraag.cursor !== undefined) query.set('cursor', aanvraag.cursor);
      const pad = `/api/v1/linkedin/search?${query.toString()}`;
      const body: Record<string, unknown> = {
        api: aanvraag.api ?? 'classic',
        category: aanvraag.category ?? 'people',
        ...(aanvraag.filters ?? {}),
      };
      if (aanvraag.keywords !== undefined) body['keywords'] = aanvraag.keywords;
      const res = await verzoek('POST', pad, { json: body });
      const parsed = await ontleed<{
        items?: Array<Record<string, unknown>>;
        paging?: { total_count?: number };
        cursor?: string;
      }>(res, pad, { accountId: aanvraag.accountId });
      const uit: ZoekResultaat = { items: parsed.items ?? [] };
      if (parsed.paging?.total_count !== undefined) uit.pagingTotalCount = parsed.paging.total_count;
      if (parsed.cursor !== undefined) uit.cursor = parsed.cursor;
      return uit;
    },

    async stuurInvite(aanvraag) {
      const endpoint = '/api/v1/users/invite';
      const body: Record<string, unknown> = {
        account_id: aanvraag.accountId,
        provider_id: aanvraag.providerId,
      };
      if (aanvraag.message !== undefined) body['message'] = aanvraag.message;
      if (aanvraag.userEmail !== undefined) body['user_email'] = aanvraag.userEmail;
      const res = await verzoek('POST', endpoint, { json: body });
      const parsed = await ontleed<{ invitation_id: string; usage?: unknown }>(res, endpoint, {
        accountId: aanvraag.accountId,
      });
      const usage = leesUsage(parsed.usage);
      return {
        invitationId: parsed.invitation_id,
        ...(usage ? { usage } : {}),
      };
    },

    async telVerstuurdeInvites(aanvraag) {
      const endpoint = '/api/v1/users/invite/sent';
      let aantal = 0;
      let paginas = 0;
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          account_id: aanvraag.accountId,
          limit: String(aanvraag.paginaGrootte),
        });
        if (cursor) query.set('cursor', cursor);
        const pad = `${endpoint}?${query.toString()}`;
        const res = await verzoek('GET', pad);
        const body = await ontleed<{ items?: unknown[]; cursor?: unknown }>(res, pad, {
          accountId: aanvraag.accountId,
        });
        paginas++;
        aantal += Array.isArray(body.items) ? body.items.length : 0;
        cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : undefined;
      } while (cursor && paginas < aanvraag.maxPaginas);
      return { aantal, volledig: cursor === undefined, paginas };
    },

    async stuurBericht(aanvraag) {
      const endpoint = `/api/v1/chats/${encodeURIComponent(aanvraag.chatId)}/messages`;
      const fd = new FormData();
      fd.append('account_id', aanvraag.accountId);
      fd.append('text', aanvraag.tekst);
      if (aanvraag.quoteId) fd.append('quote_id', aanvraag.quoteId);
      const res = await verzoek('POST', endpoint, { formData: fd });
      const parsed = await ontleed<{ message_id: string }>(res, endpoint, {
        accountId: aanvraag.accountId,
      });
      return { messageId: parsed.message_id };
    },

    async startGesprek(aanvraag) {
      const endpoint = '/api/v1/chats';
      const fd = new FormData();
      fd.append('account_id', aanvraag.accountId);
      for (const id of aanvraag.attendeesIds) fd.append('attendees_ids', id);
      fd.append('text', aanvraag.tekst);
      if (aanvraag.onderwerp) fd.append('subject', aanvraag.onderwerp);
      if (aanvraag.linkedinApi) fd.append('linkedin[api]', aanvraag.linkedinApi);
      if (aanvraag.isInmail) fd.append('linkedin[inmail]', 'true');
      const res = await verzoek('POST', endpoint, { formData: fd });
      const parsed = await ontleed<{ chat_id: string; message_id: string }>(res, endpoint, {
        accountId: aanvraag.accountId,
      });
      return { chatId: parsed.chat_id, messageId: parsed.message_id };
    },
  };
}

function endpointVan(pad: string): string {
  const zonderQuery = pad.split('?')[0] ?? pad;
  return zonderQuery;
}

function leesUsage(raw: unknown): UsageSignaal | undefined {
  if (raw === undefined || raw === null) return undefined;
  const getal =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.replace('%', '').trim())
        : NaN;
  if (getal === 50 || getal === 75 || getal === 90 || getal === 95) {
    return { percentage: getal };
  }
  return undefined;
}
