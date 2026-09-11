# Custom Email

Create a Zoho mailbox on a selected Namecheap domain from Codex or Claude:

> Create `hello@example.com`.

The plugin connects each user’s own Zoho account, prepares the exact DNS records, opens Namecheap in the user’s browser, verifies propagation, and creates the mailbox. It does not need Namecheap API access or credentials.

## User flow

1. Install the plugin and connect your own Zoho Mail administrator account.
2. Ask to create an email address.
3. Choose a domain if the address did not already specify one.
4. Approve the Zoho and DNS preview.
5. Open Namecheap Advanced DNS; the AI enters the generated records when browser control is available, or shows a compact copyable table.
6. Let the MCP verify propagation and receive the mailbox with a one-use password link.

OAuth sessions refresh automatically. Provider connections remain encrypted until removed.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm run dev
```

Generate `MASTER_ENCRYPTION_KEY` with:

```bash
openssl rand -base64 32
```

Set up one Zoho server application with callback `${PUBLIC_URL}/oauth/zoho/callback`. Its client credentials identify this application; every customer still authorizes their own Zoho account.

The development plugin points to `http://localhost:3000/mcp`. Install the repository marketplace, then install `custom-email` and authenticate it.

During the Git beta, a user adds the repository URL as a marketplace once and selects **Install**. After public plugin submission, that becomes a single marketplace install with no Git or terminal steps.

## Deploy

Deploy the Docker image as one HTTPS service with:

- A persistent volume at `/data`.
- `PUBLIC_URL`, `MASTER_ENCRYPTION_KEY`, and Zoho OAuth credentials.

After deployment, set the plugin to the live endpoint:

```bash
npm run plugin:url -- https://your-domain.example/mcp
```

Commit the updated plugin files and marketplace to Git. Users install the plugin; they do not clone or run the server.

## Verify

```bash
npm run check
```

The current storage layer supports a single hosted instance for a fast beta. Move OAuth and provider state to a managed database before horizontal scaling.

## Multiple domains

Zoho can host multiple domains in one organization. The free/trial plan supports one domain; paid organizations support up to 30. Use one organization when the same administrators, users, policies, and billing should manage all domains. Use separate Zoho organizations when those boundaries must remain independent.
