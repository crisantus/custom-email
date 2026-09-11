import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OAuthRequestError, OAuthService } from '../src/oauth.js';
import { FileStore } from '../src/store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'custom-email-oauth-'));
  directories.push(directory);
  const key = randomBytes(32);
  const store = new FileStore(join(directory, 'state.json'), key);
  await store.init();
  return { store, oauth: new OAuthService(store, 'https://mail.example.com', key) };
}

async function authorize(oauth: OAuthService, cookie?: string) {
  const client = await oauth.registerClient({
    client_name: 'Codex',
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none'
  });
  const verifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const requestId = await oauth.beginAuthorization(new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: 'https://mail.example.com/mcp'
  }));
  const approved = await oauth.approveAuthorization(requestId, cookie);
  const code = new URL(approved.redirect).searchParams.get('code')!;
  const tokens = await oauth.exchangeToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_verifier: verifier
  }));
  return { client, approved, tokens, auth: oauth.authenticate(`Bearer ${tokens.access_token}`)! };
}

describe('MCP OAuth', () => {
  it('registers a public client, uses PKCE, and refreshes tokens', async () => {
    const { oauth } = await fixture();
    const result = await authorize(oauth);

    expect(result.approved.redirect).toContain('state=state-123');
    expect(result.approved.redirect).toContain('iss=https%3A%2F%2Fmail.example.com');
    expect(result.auth.extra?.userId).toBeTypeOf('string');
    expect(result.auth.scopes).toEqual(['email:read', 'email:write']);

    const refreshed = await oauth.exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: result.tokens.refresh_token,
      client_id: result.client.client_id
    }));
    expect(refreshed.access_token).not.toBe(result.tokens.access_token);
    expect(oauth.authenticate(`Bearer ${refreshed.access_token}`)?.extra?.userId).toBe(result.auth.extra?.userId);
  });

  it('isolates separate installations while preserving a signed browser identity', async () => {
    const { oauth, store } = await fixture();
    const first = await authorize(oauth);
    const second = await authorize(oauth);
    expect(second.auth.extra?.userId).not.toBe(first.auth.extra?.userId);

    await store.saveConnections(String(first.auth.extra?.userId), {
      zoho: { refreshToken: 'secret', orgId: 'org-1', dataCenter: 'com' }
    });
    expect(store.getConnections(String(second.auth.extra?.userId))).toEqual({});

    const cookie = first.approved.setCookie.split(';')[0];
    const returning = await authorize(oauth, cookie);
    expect(returning.auth.extra?.userId).toBe(first.auth.extra?.userId);
  });

  it('rejects unsafe redirect URIs', async () => {
    const { oauth } = await fixture();
    await expect(oauth.registerClient({ redirect_uris: ['http://attacker.example/callback'] }))
      .rejects.toEqual(expect.objectContaining<Partial<OAuthRequestError>>({ error: 'invalid_redirect_uri' }));
  });
});
