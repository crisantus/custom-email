import { AppError } from '../errors.js';
import type { DkimDetails, ZohoConnection, ZohoDataCenter, ZohoDomain } from '../types.js';

const REGIONS: Record<ZohoDataCenter, { accounts: string; mail: string; mxSuffix: string }> = {
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com', mxSuffix: 'zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu', mxSuffix: 'zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', mail: 'https://mail.zoho.in', mxSuffix: 'zoho.in' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au', mxSuffix: 'zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', mail: 'https://mail.zoho.jp', mxSuffix: 'zoho.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', mail: 'https://mail.zohocloud.ca', mxSuffix: 'zohocloud.ca' },
  'com.cn': { accounts: 'https://accounts.zoho.com.cn', mail: 'https://mail.zoho.com.cn', mxSuffix: 'zoho.com.cn' },
  ae: { accounts: 'https://accounts.zoho.ae', mail: 'https://mail.zoho.ae', mxSuffix: 'zoho.ae' },
  sa: { accounts: 'https://accounts.zoho.sa', mail: 'https://mail.zoho.sa', mxSuffix: 'zoho.sa' }
};

export class ZohoClient {
  private accessToken?: { value: string; expiresAt: number };
  private readonly region;

  constructor(
    private readonly connection: ZohoConnection,
    private readonly app: { clientId: string; clientSecret: string },
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.region = REGIONS[connection.dataCenter];
  }

  static authorizationUrl(options: {
    clientId: string;
    publicUrl: string;
    state: string;
    dataCenter: ZohoDataCenter;
  }): string {
    const region = REGIONS[options.dataCenter];
    const url = new URL('/oauth/v2/auth', region.accounts);
    url.search = new URLSearchParams({
      client_id: options.clientId,
      response_type: 'code',
      redirect_uri: `${options.publicUrl}/oauth/zoho/callback`,
      scope: 'ZohoMail.organization.domains.ALL,ZohoMail.organization.accounts.ALL,ZohoMail.partner.organization.READ',
      access_type: 'offline',
      prompt: 'consent',
      state: options.state
    }).toString();
    return url.toString();
  }

  static async exchangeCode(options: {
    code: string;
    clientId: string;
    clientSecret: string;
    publicUrl: string;
    dataCenter: ZohoDataCenter;
    fetcher?: typeof fetch;
  }): Promise<{ refreshToken: string; accessToken: string }> {
    const response = await (options.fetcher ?? fetch)(`${REGIONS[options.dataCenter].accounts}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: options.code,
        grant_type: 'authorization_code',
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: `${options.publicUrl}/oauth/zoho/callback`
      })
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof data.refresh_token !== 'string') {
      throw new AppError('Zoho authorization did not return a refresh token. Reconnect and approve offline access.', 'authentication');
    }
    if (typeof data.access_token !== 'string') throw new AppError('Zoho authorization did not return an access token.', 'authentication');
    return { refreshToken: data.refresh_token, accessToken: data.access_token };
  }

  static async discoverOrgId(accessToken: string, dataCenter: ZohoDataCenter, fetcher: typeof fetch = fetch): Promise<string> {
    const response = await fetcher(`${REGIONS[dataCenter].mail}/api/organization`, {
      headers: { accept: 'application/json', authorization: `Zoho-oauthtoken ${accessToken}` }
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new AppError('Connected to Zoho, but could not find a Mail organization. Create or enable Zoho Mail hosting, then reconnect.', 'configuration');
    const candidate = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    const orgId = candidate?.zoid ?? candidate?.orgId ?? candidate?.organizationId;
    if (!orgId) throw new AppError('Connected to Zoho, but no organization ID was returned.', 'configuration');
    return String(orgId);
  }

  async checkConnection(): Promise<void> {
    await this.listDomains();
  }

  async listDomains(): Promise<ZohoDomain[]> {
    const data = await this.api(`/api/organization/${this.connection.orgId}/domains`);
    return asArray(data.data?.domainVO ?? data.data).map(normalizeDomain).filter((domain) => domain.domainName);
  }

  async getDomain(domain: string): Promise<ZohoDomain | undefined> {
    try {
      const data = await this.api(`/api/organization/${this.connection.orgId}/domains/${encodeURIComponent(domain)}`);
      const result = normalizeDomain(data.data);
      return result.domainName ? result : undefined;
    } catch (error) {
      if (error instanceof AppError && error.details?.status === 404) return undefined;
      throw error;
    }
  }

  async addDomain(domain: string): Promise<ZohoDomain> {
    const data = await this.api(`/api/organization/${this.connection.orgId}/domains`, {
      method: 'POST', body: { domainName: domain }
    });
    return normalizeDomain(data.data);
  }

  async verifyDomain(domain: string): Promise<boolean> {
    const data = await this.domainAction(domain, { mode: 'verifyDomainByCName' });
    return data.data?.status === true;
  }

  async createDkim(domain: string, selector = 'zmail'): Promise<DkimDetails> {
    const data = await this.domainAction(domain, { mode: 'addDkimDetail', selector, isDefault: true, keySize: 2048 });
    return {
      selector: String(data.data.selector),
      publicKey: String(data.data.publicKey),
      dkimId: String(data.data.dkimId)
    };
  }

  async verifyDkim(domain: string, dkimId: string): Promise<boolean> {
    const data = await this.domainAction(domain, { mode: 'verifyDkimKey', dkimId });
    return data.data?.dkimstatus === true;
  }

  async verifyMx(domain: string): Promise<void> {
    await this.domainAction(domain, { mode: 'VerifyMxRecord' });
  }

  async verifySpf(domain: string): Promise<void> {
    await this.domainAction(domain, { mode: 'VerifySpfRecord' });
  }

  async createMailbox(input: {
    email: string; password: string; firstName: string; lastName?: string; displayName?: string;
  }): Promise<{ created: boolean; account: Record<string, unknown> }> {
    const existing = await this.findMailbox(input.email);
    if (existing) return { created: false, account: existing };
    const data = await this.api(`/api/organization/${this.connection.orgId}/accounts`, {
      method: 'POST',
      body: {
        primaryEmailAddress: input.email,
        password: input.password,
        firstName: input.firstName,
        lastName: input.lastName ?? '',
        displayName: input.displayName ?? input.firstName,
        role: 'member',
        oneTimePassword: true
      }
    });
    return { created: true, account: data.data as Record<string, unknown> };
  }

  async findMailbox(email: string): Promise<Record<string, unknown> | undefined> {
    try {
      const data = await this.api(`/api/organization/${this.connection.orgId}/accounts/${encodeURIComponent(email)}`);
      return data.data as Record<string, unknown>;
    } catch (error) {
      if (error instanceof AppError && error.details?.status === 404) return undefined;
      throw error;
    }
  }

  getMailRecords() {
    return {
      mx: [
        { host: '@', type: 'MX' as const, value: `mx.${this.region.mxSuffix}`, mxPriority: 10, ttl: 1800 },
        { host: '@', type: 'MX' as const, value: `mx2.${this.region.mxSuffix}`, mxPriority: 20, ttl: 1800 },
        { host: '@', type: 'MX' as const, value: `mx3.${this.region.mxSuffix}`, mxPriority: 50, ttl: 1800 }
      ],
      spf: { host: '@', type: 'TXT' as const, value: 'v=spf1 include:zohomail.com -all', ttl: 1800 }
    };
  }

  private async domainAction(domain: string, body: Record<string, unknown>): Promise<any> {
    return this.api(`/api/organization/${this.connection.orgId}/domains/${encodeURIComponent(domain)}`, { method: 'PUT', body });
  }

  private async api(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
    const token = await this.getAccessToken();
    const response = await this.fetcher(`${this.region.mail}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Zoho-oauthtoken ${token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok || (data.status?.code && Number(data.status.code) >= 400)) {
      throw new AppError(`Zoho rejected the request: ${data.status?.description ?? `HTTP ${response.status}`}`, response.status === 401 ? 'authentication' : 'provider_error', { status: response.status });
    }
    return data;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const response = await this.fetcher(`${this.region.accounts}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.connection.refreshToken,
        grant_type: 'refresh_token',
        client_id: this.app.clientId,
        client_secret: this.app.clientSecret
      })
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof data.access_token !== 'string') throw new AppError('Zoho connection expired or was revoked. Reconnect Zoho.', 'authentication');
    this.accessToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.accessToken.value;
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDomain(value: any): ZohoDomain {
  return {
    domainName: String(value?.domainName ?? ''),
    verificationStatus: value?.verificationStatus === true,
    cnameVerificationCode: value?.CNAMEVerificationCode ? String(value.CNAMEVerificationCode) : undefined,
    mxStatus: value?.mxStatus ?? value?.mxstatus,
    spfStatus: value?.spfStatus ?? value?.spfstatus,
    dkimStatus: value?.dkimStatus ?? value?.dkimstatus
  };
}
