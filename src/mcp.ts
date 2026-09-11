import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { config } from './config.js';
import { safeError } from './errors.js';
import type { FileStore } from './store.js';
import { EmailSetupWorkflow } from './workflows/email-setup.js';

export function createCustomEmailMcp(store: FileStore) {
  return createMcpHandler((context) => {
    const userId = typeof context.authInfo?.extra?.userId === 'string'
      ? context.authInfo.extra.userId
      : config.userId;
    const workflow = new EmailSetupWorkflow(store, userId, {
      publicUrl: config.publicUrl,
      zohoClientId: config.zoho.clientId,
      zohoClientSecret: config.zoho.clientSecret
    });
    const server = new McpServer(
      { name: 'custom-email', version: '0.2.0' },
      {
        instructions: 'Prefer create_custom_email for the normal flow. Connect only the user\'s own Zoho account. If no domain is supplied, ask which Namecheap domain to use; if the email already contains a domain, that is the selection. Open the returned Namecheap Advanced DNS URL in the user browser and enter the returned records only after approval. Never expose credentials or passwords in chat. Never remove existing MX records without explicit approval. Treat propagation_pending as normal.'
      }
    );

    server.registerTool('create_custom_email', {
      title: 'Create custom email',
      description: 'Run the simplest end-to-end flow: connect accounts if needed, preview changes, configure the domain, and create the mailbox.',
      inputSchema: z.object({
        email: z.string().email().optional().describe('Full mailbox address, for example hello@example.com'),
        domain: z.string().optional().describe('Domain selected by the user when email is not supplied'),
        localPart: z.string().optional().describe('Mailbox name before @ when email is not supplied'),
        firstName: z.string().min(1).optional().describe('Mailbox owner first name; defaults to the mailbox name'),
        lastName: z.string().optional(),
        displayName: z.string().optional(),
        confirm: z.boolean().default(false).describe('Set true only after the user approves the returned preview')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    }, async ({ email, domain: chosenDomain, localPart: chosenLocalPart, firstName, lastName, displayName, confirm }) => safely(async () => {
      const connections = await workflow.checkConnections();
      if (!connections.ready) {
        const session = await store.createOnboarding(userId);
        return {
          status: 'connect_accounts',
          url: `${config.publicUrl}/connect/${session.code}`,
          expiresInMinutes: 15,
          message: 'Connect your own Zoho Mail administrator account, then repeat the same request.'
        };
      }
      if (!email && !chosenDomain) {
        const domains = await workflow.listDomains();
        return { status: 'domain_required', ...domains, message: 'Ask the user which Namecheap domain they want to configure.' };
      }
      if (!email && !chosenLocalPart) {
        return { status: 'mailbox_name_required', domain: chosenDomain, message: 'Ask what address they want before the @ sign.' };
      }
      const resolvedEmail = email ?? `${chosenLocalPart}@${chosenDomain}`;
      const at = resolvedEmail.lastIndexOf('@');
      const localPart = resolvedEmail.slice(0, at).toLowerCase();
      const domain = resolvedEmail.slice(at + 1).toLowerCase();
      const plan = await workflow.plan(domain);
      if (!confirm) {
        return {
          status: 'approval_required',
          email: resolvedEmail,
          ...plan,
          message: 'Show this short preview to the user and ask for one approval. Then call this tool again with confirm=true.'
        };
      }
      const setup = await workflow.advance(domain, { confirm: true });
      if (setup.status !== 'ready_for_mailbox') return { ...setup, email: resolvedEmail };
      const ownerName = firstName ?? localPart.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
      return workflow.createMailbox({ domain, localPart, firstName: ownerName, lastName, displayName });
    }));

    server.registerTool('start_setup', {
      title: 'Connect Zoho Mail',
      description: 'Create a short-lived secure onboarding link for connecting the user\'s own Zoho Mail account.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    }, async () => safely(async () => {
      const session = await store.createOnboarding(userId);
      return {
        status: 'action_required',
        url: `${config.publicUrl}/connect/${session.code}`,
        expiresInMinutes: 15,
        message: 'Open the secure link and connect your own Zoho Mail administrator account. Do not paste credentials into chat.'
      };
    }));

    server.registerTool('check_connections', {
      title: 'Check provider connections',
      description: 'Check whether Namecheap and Zoho have been connected.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    }, async () => safely(async () => workflow.checkConnections()));

    server.registerTool('list_domains', {
      title: 'List domains',
      description: 'List domains already present in the connected Zoho organization and indicate when the user must choose a Namecheap domain.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    }, async () => safely(async () => workflow.listDomains()));

    server.registerTool('plan_email_setup', {
      title: 'Preview email setup',
      description: 'Read current provider state and preview DNS changes without modifying anything.',
      inputSchema: z.object({
        domain: z.string().describe('Root domain, for example example.com'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    }, async ({ domain }) => safely(async () => workflow.plan(domain)));

    server.registerTool('apply_email_setup', {
      title: 'Continue domain email setup',
      description: 'Advance the Zoho setup and return the exact records to enter in the user\'s open Namecheap browser.',
      inputSchema: z.object({
        domain: z.string(),
        confirm: z.literal(true).describe('Must be true after the user approves the setup')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    }, async ({ domain, confirm }) => safely(async () => workflow.advance(domain, { confirm })));

    server.registerTool('continue_email_setup', {
      title: 'Continue after Namecheap DNS changes',
      description: 'Ask Zoho to verify the records after they were entered in Namecheap, then return the next records or readiness state.',
      inputSchema: z.object({
        domain: z.string(),
        confirm: z.literal(true).describe('Confirms the user says the displayed DNS records were entered')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    }, async ({ domain, confirm }) => safely(async () => workflow.advance(domain, { confirm })));

    server.registerTool('check_email_status', {
      title: 'Check email readiness',
      description: 'Read Zoho verification state and show the records required in Namecheap without changing anything.',
      inputSchema: z.object({ domain: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    }, async ({ domain }) => safely(async () => workflow.status(domain)));

    server.registerTool('create_mailbox', {
      title: 'Create mailbox',
      description: 'Create a Zoho mailbox on a verified domain and return a short-lived one-time password link.',
      inputSchema: z.object({
        domain: z.string(),
        localPart: z.string().describe('The part before @, for example hello'),
        firstName: z.string().min(1),
        lastName: z.string().optional(),
        displayName: z.string().optional(),
        confirm: z.literal(true).describe('Must be true after the user approves mailbox creation')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    }, async ({ domain, localPart, firstName, lastName, displayName }) => safely(async () =>
      workflow.createMailbox({ domain, localPart, firstName, lastName, displayName })
    ));

    return server;
  }, { responseMode: 'auto' });
}

async function safely(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const safe = safeError(error);
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(safe, null, 2) }] };
  }
}
