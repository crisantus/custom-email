# PRD — Custom Email MCP

## Goal

Let a developer create a working Zoho email address on a selected Namecheap domain with minimal manual work.

## Experience

1. Install the plugin and connect the user’s own Zoho account.
2. Ask which domain to use when the request does not already specify one.
3. Add the domain to Zoho and generate its DNS records.
4. Open Namecheap Advanced DNS in the user’s browser and enter the records with approval.
5. Verify Zoho and create the mailbox.

## Product responsibilities

- Isolate and refresh each user’s Zoho authorization.
- Support one or many domains in a Zoho organization.
- Never require or store Namecheap credentials.
- Generate and verify Zoho ownership, MX, SPF, and DKIM records.
- Warn before replacing existing MX records.
- Create mailboxes idempotently.
- Resume automatically after DNS propagation.

## MVP boundaries

Zoho Mail plus browser-assisted Namecheap DNS. No Namecheap API, domain purchases, email client, billing, teams, or Apple Developer workflow.

## Success

A returning user selects a domain, approves the changes, and receives a working mailbox without reconnecting Zoho.
