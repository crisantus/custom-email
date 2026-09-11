import { createHash } from 'node:crypto';

const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const resource = `${base}/mcp`;

const metadata = await getJson(`${base}/.well-known/oauth-authorization-server`);
if (metadata.token_endpoint !== `${base}/oauth/token`) throw new Error('OAuth discovery failed.');

const client = await postJson(`${base}/oauth/register`, {
  client_name: 'Custom Email smoke test',
  redirect_uris: ['http://127.0.0.1:45678/callback'],
  token_endpoint_auth_method: 'none'
});

const verifier = 'smoke-test-verifier-'.padEnd(64, 'x');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorization = new URL(metadata.authorization_endpoint);
authorization.search = new URLSearchParams({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0],
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'smoke',
  resource
}).toString();

const approvalPage = await fetch(authorization);
const approvalHtml = await approvalPage.text();
const requestId = approvalHtml.match(/name="requestId" value="([A-Za-z0-9_-]+)"/)?.[1];
if (!approvalPage.ok || !requestId) throw new Error('Authorization page failed.');

const approval = await fetch(`${base}/oauth/authorize`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ requestId })
});
const callback = new URL(approval.headers.get('location'));
const code = callback.searchParams.get('code');
if (approval.status !== 302 || !code || callback.searchParams.get('state') !== 'smoke') throw new Error('Authorization approval failed.');

const tokens = await postForm(metadata.token_endpoint, {
  grant_type: 'authorization_code',
  code,
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0],
  code_verifier: verifier
});
const refreshed = await postForm(metadata.token_endpoint, {
  grant_type: 'refresh_token',
  refresh_token: tokens.refresh_token,
  client_id: client.client_id
});

const mcp = await fetch(resource, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${refreshed.access_token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } }
  })
});
const mcpBody = await mcp.text();
if (!mcp.ok || !mcpBody.includes('custom-email')) throw new Error(`MCP handshake failed: ${mcp.status} ${mcpBody}`);

console.log('OAuth discovery, registration, PKCE, refresh, and authenticated MCP handshake passed.');

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}.`);
  return response.json();
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function postForm(url, value) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(value)
  });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}
