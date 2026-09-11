# Architecture — Custom Email

```text
Git repository ──deploys──> Hosted HTTPS service
                              ├── MCP + OAuth
Codex/Claude plugin ──────────>├── One-page onboarding
                              ├── Email workflow
                              ├── Encrypted user state
                              └── Zoho Mail OAuth/API

User browser ────────────────> Namecheap Advanced DNS
                               (records supplied by MCP)
```

## Request flow

1. The plugin discovers the hosted MCP OAuth endpoints.
2. OAuth creates an isolated user identity and refreshable client session.
3. Each user connects their own Zoho organization.
4. If no domain is specified, the MCP asks which Namecheap domain to use.
5. Zoho creates the domain and returns ownership, MX, SPF, and DKIM records.
6. The AI opens Namecheap Advanced DNS in the user’s browser and enters approved records.
7. The MCP verifies propagation and creates the mailbox.

## Safety

- Zoho tokens are encrypted per user and never enter chat.
- OAuth access and refresh tokens are random, hashed at rest, scoped, expiring, and rotated.
- MCP clients use OAuth Authorization Code with PKCE and dynamic client registration.
- The service never receives Namecheap passwords or API keys.
- Existing MX records are never removed without explicit approval.
- Repeated operations skip completed work.

## Deployment

Run one container behind HTTPS with persistent storage. The plugin contains only the public `/mcp` URL. Git hosts the code and marketplace; the deployed service performs Zoho operations while DNS changes happen in the user’s browser.

Use a managed transactional database and secret manager before running multiple service instances.
