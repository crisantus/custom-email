import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { FileStore } from './store.js';

const SCOPES = ['email:read', 'email:write'];
const USER_COOKIE = 'custom_email_user';

export class OAuthRequestError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export class OAuthService {
  readonly issuer: string;
  readonly resource: string;

  constructor(
    private readonly store: FileStore,
    publicUrl: string,
    private readonly signingKey: Buffer
  ) {
    this.issuer = publicUrl.replace(/\/$/, '');
    this.resource = `${this.issuer}/mcp`;
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header']
    };
  }

  async registerClient(body: unknown) {
    const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || !input.redirect_uris.every(isAllowedRedirectUri)) {
      throw new OAuthRequestError('invalid_redirect_uri', 'Provide at least one HTTPS or loopback redirect URI.');
    }
    if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') {
      throw new OAuthRequestError('invalid_client_metadata', 'Only public clients with token_endpoint_auth_method=none are supported.');
    }
    const client = await this.store.registerOAuthClient({
      redirectUris: input.redirect_uris as string[],
      clientName: typeof input.client_name === 'string' ? input.client_name.slice(0, 120) : undefined
    });
    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    };
  }

  async beginAuthorization(params: URLSearchParams): Promise<string> {
    const clientId = required(params, 'client_id');
    const redirectUri = required(params, 'redirect_uri');
    const client = this.store.getOAuthClient(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) throw new OAuthRequestError('invalid_request', 'Unknown client or redirect URI.');
    if (params.get('response_type') !== 'code') throw new OAuthRequestError('unsupported_response_type', 'Only response_type=code is supported.');
    const codeChallenge = required(params, 'code_challenge');
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw new OAuthRequestError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const resource = params.get('resource') ?? this.resource;
    if (resource !== this.resource) throw new OAuthRequestError('invalid_target', 'The requested resource is not supported.');
    const scope = parseScope(params.get('scope'));
    return this.store.createOAuthAuthorizationRequest({
      clientId,
      redirectUri,
      state: params.get('state') ?? undefined,
      codeChallenge,
      scope,
      resource,
      expiresAt: Date.now() + 10 * 60_000
    });
  }

  async approveAuthorization(requestId: string, cookieHeader?: string): Promise<{ redirect: string; setCookie: string }> {
    const request = await this.store.consumeOAuthAuthorizationRequest(requestId);
    if (!request) throw new OAuthRequestError('invalid_request', 'This authorization request expired.');
    const userId = this.readUserId(cookieHeader) ?? randomBytes(18).toString('base64url');
    const code = await this.store.createOAuthAuthorizationCode({
      ...request,
      userId,
      expiresAt: Date.now() + 5 * 60_000
    });
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', this.issuer);
    return {
      redirect: redirect.toString(),
      setCookie: `${USER_COOKIE}=${this.signUserId(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${this.issuer.startsWith('https://') ? '; Secure' : ''}`
    };
  }

  async exchangeToken(params: URLSearchParams) {
    const grantType = required(params, 'grant_type');
    if (grantType === 'authorization_code') return this.exchangeAuthorizationCode(params);
    if (grantType === 'refresh_token') return this.exchangeRefreshToken(params);
    throw new OAuthRequestError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }

  authenticate(authorization?: string): AuthInfo | undefined {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const raw = authorization.slice(7).trim();
    const record = raw ? this.store.getOAuthAccessToken(raw) : undefined;
    if (!record || record.resource !== this.resource) return undefined;
    return {
      token: raw,
      clientId: record.clientId,
      scopes: record.scope,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(record.resource),
      extra: { userId: record.userId }
    };
  }

  private async exchangeAuthorizationCode(params: URLSearchParams) {
    const code = await this.store.consumeOAuthAuthorizationCode(required(params, 'code'));
    if (!code) throw new OAuthRequestError('invalid_grant', 'The authorization code is invalid or expired.');
    if (required(params, 'client_id') !== code.clientId || required(params, 'redirect_uri') !== code.redirectUri) {
      throw new OAuthRequestError('invalid_grant', 'The authorization code does not match this client.');
    }
    const verifier = required(params, 'code_verifier');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!constantTimeEqual(challenge, code.codeChallenge)) throw new OAuthRequestError('invalid_grant', 'PKCE verification failed.');
    return this.tokenResponse(await this.store.issueOAuthTokens({
      userId: code.userId,
      clientId: code.clientId,
      scope: code.scope,
      resource: code.resource
    }), code.scope);
  }

  private async exchangeRefreshToken(params: URLSearchParams) {
    const rotated = await this.store.rotateOAuthRefreshToken(required(params, 'refresh_token'));
    if (!rotated || required(params, 'client_id') !== rotated.record.clientId) {
      throw new OAuthRequestError('invalid_grant', 'The refresh token is invalid or expired.');
    }
    return this.tokenResponse(rotated, rotated.record.scope);
  }

  private tokenResponse(tokens: { accessToken: string; refreshToken: string; expiresIn: number }, scope: string[]) {
    return {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: scope.join(' ')
    };
  }

  private signUserId(userId: string): string {
    const signature = createHmac('sha256', this.signingKey).update(userId).digest('base64url');
    return `${userId}.${signature}`;
  }

  private readUserId(cookieHeader?: string): string | undefined {
    const raw = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${USER_COOKIE}=`))?.slice(USER_COOKIE.length + 1);
    if (!raw) return undefined;
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return undefined;
    const userId = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    return constantTimeEqual(this.signUserId(userId).slice(userId.length + 1), signature) ? userId : undefined;
  }
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) throw new OAuthRequestError('invalid_request', `Missing ${name}.`);
  return value;
}

function parseScope(raw: string | null): string[] {
  const requested = raw?.split(/\s+/).filter(Boolean) ?? SCOPES;
  if (requested.some((scope) => !SCOPES.includes(scope))) throw new OAuthRequestError('invalid_scope', 'An unsupported scope was requested.');
  return [...new Set(requested)];
}

function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
