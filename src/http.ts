import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { config } from './config.js';
import { safeError } from './errors.js';
import { createCustomEmailMcp } from './mcp.js';
import { OAuthRequestError, OAuthService } from './oauth.js';
import { ZohoClient } from './providers/zoho.js';
import type { FileStore } from './store.js';
import type { ZohoDataCenter } from './types.js';

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };
const DATA_CENTERS: ZohoDataCenter[] = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'com.cn', 'ae', 'sa'];

export function createHttpServer(store: FileStore) {
  const mcp = createCustomEmailMcp(store);
  const oauth = new OAuthService(store, config.publicUrl, config.encryptionKey);
  const handleMcp = toNodeHandler(mcp, { onerror: (error) => console.error('[mcp]', error.message) });

  const server = createServer(async (request: AuthenticatedRequest, response) => {
    try {
      const url = new URL(request.url ?? '/', config.publicUrl);
      setSecurityHeaders(response);

      if (url.pathname === '/health') return json(response, 200, { status: 'ok' });
      if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
        return json(response, 200, oauth.authorizationServerMetadata());
      }
      if ((url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') {
        return json(response, 200, oauth.protectedResourceMetadata());
      }
      if (url.pathname === '/oauth/register' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request)) as unknown;
        return json(response, 201, await oauth.registerClient(body), { 'cache-control': 'no-store' });
      }
      if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
        const requestId = await oauth.beginAuthorization(url.searchParams);
        return html(response, 200, authorizePage(requestId));
      }
      if (url.pathname === '/oauth/authorize' && request.method === 'POST') {
        const form = new URLSearchParams(await readBody(request));
        const approved = await oauth.approveAuthorization(form.get('requestId') ?? '', request.headers.cookie);
        response.writeHead(302, { location: approved.redirect, 'set-cookie': approved.setCookie, 'cache-control': 'no-store' });
        return response.end();
      }
      if (url.pathname === '/oauth/token' && request.method === 'POST') {
        const result = await oauth.exchangeToken(new URLSearchParams(await readBody(request)));
        return json(response, 200, result, { 'cache-control': 'no-store' });
      }
      if (url.pathname === '/mcp') {
        const auth = oauth.authenticate(request.headers.authorization);
        if (!auth) return unauthorized(response, oauth.resource);
        request.auth = auth;
        return handleMcp(request, response);
      }
      if (url.pathname === '/' && request.method === 'GET') return html(response, 200, homePage());

      const connectMatch = url.pathname.match(/^\/connect\/([A-Za-z0-9_-]+)$/);
      if (connectMatch && request.method === 'GET') return renderConnect(response, store, connectMatch[1]);

      const zohoMatch = url.pathname.match(/^\/connect\/([A-Za-z0-9_-]+)\/zoho$/);
      if (zohoMatch && request.method === 'GET') return beginZoho(response, store, zohoMatch[1], url.searchParams.get('dc'));

      if (url.pathname === '/oauth/zoho/callback' && request.method === 'GET') return finishZoho(response, store, url);

      const secretMatch = url.pathname.match(/^\/secret\/([A-Za-z0-9_-]+)$/);
      if (secretMatch && request.method === 'GET') return html(response, 200, secretPage(secretMatch[1]));
      if (secretMatch && request.method === 'POST') return revealSecret(response, store, secretMatch[1]);

      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof OAuthRequestError) {
        return json(response, error.status, { error: error.error, error_description: error.message }, { 'cache-control': 'no-store' });
      }
      console.error('[http]', error instanceof Error ? error.message : error);
      return json(response, 500, safeError(error));
    }
  });

  server.on('close', () => void mcp.close());
  return server;
}

async function renderConnect(response: ServerResponse, store: FileStore, code: string, notice = '') {
  const session = store.findOnboarding(code);
  if (!session) return html(response, 410, messagePage('This setup link expired', 'Return to your AI assistant and ask it to start setup again.'));
  const connections = store.getConnections(session.userId);
  return html(response, 200, connectPage(code, Boolean(connections.zoho), notice));
}

function beginZoho(response: ServerResponse, store: FileStore, code: string, rawDc: string | null) {
  const session = store.findOnboarding(code);
  if (!session) return html(response, 410, messagePage('This setup link expired', 'Start setup again from your AI assistant.'));
  if (!config.zoho.clientId || !config.zoho.clientSecret) return renderConnect(response, store, code, 'Zoho OAuth is not configured on this server.');
  const dataCenter = DATA_CENTERS.includes(rawDc as ZohoDataCenter) ? rawDc as ZohoDataCenter : config.zoho.dataCenter;
  const state = Buffer.from(JSON.stringify({ code, dataCenter })).toString('base64url');
  response.writeHead(302, { location: ZohoClient.authorizationUrl({ clientId: config.zoho.clientId, publicUrl: config.publicUrl, state, dataCenter }) });
  response.end();
}

async function finishZoho(response: ServerResponse, store: FileStore, url: URL) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return html(response, 400, messagePage('Zoho connection failed', 'The authorization response was incomplete.'));
  let setup: { code: string; dataCenter: ZohoDataCenter };
  try {
    setup = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return html(response, 400, messagePage('Zoho connection failed', 'The setup state was invalid.'));
  }
  const session = store.findOnboarding(setup.code);
  if (!session || !DATA_CENTERS.includes(setup.dataCenter)) return html(response, 410, messagePage('This setup link expired', 'Start setup again from your AI assistant.'));
  try {
    const tokens = await ZohoClient.exchangeCode({
      code,
      clientId: config.zoho.clientId,
      clientSecret: config.zoho.clientSecret,
      publicUrl: config.publicUrl,
      dataCenter: setup.dataCenter
    });
    const orgId = await ZohoClient.discoverOrgId(tokens.accessToken, setup.dataCenter);
    const current = store.getConnections(session.userId);
    await store.saveConnections(session.userId, { ...current, zoho: { refreshToken: tokens.refreshToken, orgId, dataCenter: setup.dataCenter } });
    return renderConnect(response, store, setup.code, 'Zoho connected successfully. You can return to your AI assistant.');
  } catch (error) {
    return renderConnect(response, store, setup.code, safeError(error).message);
  }
}

async function revealSecret(response: ServerResponse, store: FileStore, code: string) {
  const secret = await store.consumeOneTimeSecret(code);
  if (!secret) return html(response, 410, messagePage('This password link expired', 'Create or reset the mailbox again.'));
  return html(response, 200, messagePage('Temporary mailbox password', `<code class="secret">${escapeHtml(secret)}</code><p>Copy it now. This link cannot be opened again.</p>`));
}

function unauthorized(response: ServerResponse, resource: string) {
  response.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': `Bearer realm="custom-email-mcp", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp", resource="${resource}"`
  });
  response.end(JSON.stringify({ error: 'unauthorized' }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, status: number, value: string) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(value);
}

function setSecurityHeaders(response: ServerResponse) {
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
}

function layout(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><main>${body}</main></body></html>`;
}

function homePage() {
  return layout('Custom Email MCP', '<p class="eyebrow">CUSTOM EMAIL MCP</p><h1>Professional email, one guided setup away.</h1><p>Connect Zoho once. Your AI guides the Namecheap DNS setup in your own browser and verifies everything automatically.</p><div class="status">OAuth and MCP are running <strong>✓</strong></div>');
}

function authorizePage(requestId: string) {
  return layout('Authorize Custom Email', `<p class="eyebrow">INSTALL CUSTOM EMAIL</p><h1>Connect Zoho once.</h1><p>Allow your AI client to configure domains and create mailboxes in the Zoho account you choose. Namecheap credentials are never collected.</p><section><h2>Custom Email can</h2><p>Prepare exact DNS records, verify mail setup, and create Zoho mailboxes only after you approve changes.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="requestId" value="${escapeHtml(requestId)}"><button>Continue securely</button></form></section>`);
}

function connectPage(code: string, zoho: boolean, notice: string) {
  const encoded = encodeURIComponent(code);
  return layout('Connect Zoho', `<p class="eyebrow">ONE-TIME SETUP</p><h1>Connect your Zoho account</h1><p>Each user signs in to their own Zoho Mail organization. Credentials go directly to Zoho—not into AI chat.</p>${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
  <section><div class="row"><h2>Zoho Mail</h2><span class="pill ${zoho ? 'done' : ''}">${zoho ? 'Connected' : 'Required'}</span></div>
  ${zoho ? '<p>Your Zoho Mail organization is ready.</p>' : `<p>Sign in as a Zoho Mail organization administrator.</p><form method="get" action="/connect/${encoded}/zoho"><label>Zoho data center<select name="dc">${DATA_CENTERS.map((dc) => `<option value="${dc}"${dc === config.zoho.dataCenter ? ' selected' : ''}>${dc}</option>`).join('')}</select></label><button>Connect Zoho</button></form><a href="https://www.zoho.com/mail/signup.html" target="_blank" rel="noreferrer">Create a Zoho Mail account ↗</a>`}</section>
  ${zoho ? '<div class="complete"><strong>Zoho is connected.</strong><br>Return to your AI assistant. It will ask which domain to configure and open Namecheap when DNS changes are ready.</div>' : ''}`);
}

function secretPage(code: string) {
  return layout('Reveal password', `<p class="eyebrow">ONE-TIME SECRET</p><h1>Reveal temporary password</h1><p>Only reveal this when you are ready to copy it. The link expires after one use.</p><form method="post" action="/secret/${encodeURIComponent(code)}"><button>Reveal password</button></form>`);
}

function messagePage(title: string, body: string) {
  return layout(title, `<h1>${escapeHtml(title)}</h1><div>${body}</div>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

const styles = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#09090b;color:#fafafa}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18231b,#09090b 45%)}main{width:min(680px,calc(100% - 32px));margin:0 auto;padding:72px 0}h1{font-size:clamp(2.25rem,7vw,4.5rem);line-height:.98;letter-spacing:-.055em;margin:.25em 0}h2{margin:0;font-size:1.2rem}p{color:#b8b8bd;line-height:1.65}.eyebrow{color:#8cffab;font-size:.75rem;font-weight:800;letter-spacing:.18em}.status,.notice,.complete,section{margin-top:24px;border:1px solid #2b2b31;border-radius:18px;padding:22px;background:#111115}.notice{border-color:#47634f;color:#d8ffe3}.complete{background:#112117;border-color:#3e8a54}.row{display:flex;justify-content:space-between;align-items:center}.pill{font-size:.75rem;padding:5px 9px;border-radius:999px;background:#34251b;color:#ffbd8b}.pill.done{background:#173c23;color:#8cffab}label{display:grid;gap:7px;margin:14px 0;color:#d8d8dc;font-size:.85rem}input,select{width:100%;padding:12px 13px;border:1px solid #38383f;border-radius:10px;background:#0b0b0e;color:#fff;font:inherit}button{border:0;border-radius:10px;padding:12px 16px;background:#80ff9f;color:#07140b;font-weight:800;cursor:pointer}a{display:inline-block;margin-top:14px;color:#9affb3}code{font-family:ui-monospace,monospace;background:#24242a;padding:3px 6px;border-radius:6px;word-break:break-all}.secret{display:block;padding:18px;font-size:1.05rem;margin:18px 0}`;
