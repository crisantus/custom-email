import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { ZohoClient } from '../providers/zoho.js';
import type { DnsRecord, ProviderConnections } from '../types.js';
import type { FileStore } from '../store.js';

export interface WorkflowConfig {
  publicUrl: string;
  zohoClientId: string;
  zohoClientSecret: string;
}

export class EmailSetupWorkflow {
  constructor(
    private readonly store: FileStore,
    private readonly userId: string,
    private readonly workflowConfig: WorkflowConfig
  ) {}

  async checkConnections() {
    const connections = this.store.getConnections(this.userId);
    const zoho = connections.zoho
      ? new ZohoClient(connections.zoho, { clientId: this.workflowConfig.zohoClientId, clientSecret: this.workflowConfig.zohoClientSecret })
      : undefined;
    const zohoResult = await Promise.resolve(
      zoho?.checkConnection() ?? Promise.reject(new AppError('Zoho is not connected.', 'authentication'))
    ).then(() => ({ status: 'fulfilled' as const, value: undefined })).catch((reason) => ({ status: 'rejected' as const, reason }));
    return {
      namecheap: { connected: false as const, required: false as const, mode: 'browser_assisted' as const },
      zoho: connectionResult(zohoResult),
      ready: zohoResult.status === 'fulfilled'
    };
  }

  async listDomains() {
    const zohoDomains = await this.client().listDomains();
    return {
      zoho: zohoDomains,
      selectionRequired: zohoDomains.length > 1,
      message: 'If the requested Namecheap account has multiple domains, ask the user which domain to configure. A domain in the requested email address counts as an explicit selection.'
    };
  }

  async plan(domain: string) {
    const normalized = normalizeDomain(domain);
    const zoho = this.client();
    const zohoDomain = await zoho.getDomain(normalized);
    return {
      domain: normalized,
      domainInZoho: Boolean(zohoDomain),
      domainVerified: Boolean(zohoDomain?.verificationStatus),
      namecheapUrl: namecheapAdvancedDnsUrl(normalized),
      providerActions: [
        ...(zohoDomain ? [] : [`Add ${normalized} to the connected Zoho Mail organization`]),
        'Open Namecheap Advanced DNS in the user browser and enter the records supplied by this MCP',
        'Verify the records with Zoho',
        'Create the requested Zoho mailbox'
      ],
      warning: 'Existing MX records may route live email elsewhere. Never remove or replace them without the user explicitly approving that mail-provider change.'
    };
  }

  async advance(domain: string, options: { confirm: boolean }) {
    if (!options.confirm) throw new AppError('Set confirm=true after the user approves the Zoho and DNS setup preview.', 'configuration');
    const normalized = normalizeDomain(domain);
    const zoho = this.client();
    let zohoDomain = await zoho.getDomain(normalized);
    const newlyAdded = !zohoDomain;
    if (!zohoDomain) zohoDomain = await zoho.addDomain(normalized);

    if (!zohoDomain.verificationStatus) {
      if (!zohoDomain.cnameVerificationCode) throw new AppError('Zoho did not return a CNAME verification code.', 'provider_error');
      const verificationCode = zohoDomain.cnameVerificationCode;
      if (!newlyAdded) {
        const verified = await zoho.verifyDomain(normalized).catch(() => false);
        if (verified) zohoDomain = { ...zohoDomain, verificationStatus: true };
      }
      if (!zohoDomain.verificationStatus) {
        return dnsAction(normalized, 'verify_domain', [verificationRecord(verificationCode)],
          newlyAdded
            ? 'Open the Namecheap page and add this ownership record. Then call continue_email_setup.'
            : 'Zoho cannot see the ownership record yet. Check it in Namecheap, wait for DNS propagation, then retry continue_email_setup.');
      }
    }

    let dkim = this.store.getDomainSetup(this.userId, normalized).dkim;
    const newlyCreatedDkim = !dkim;
    if (!dkim) {
      dkim = await zoho.createDkim(normalized);
      await this.store.saveDomainSetup(this.userId, normalized, { dkim });
    }
    const mail = zoho.getMailRecords();
    const records = [...mail.mx, mail.spf, dkimRecord(dkim.selector, dkim.publicKey)];
    if (newlyCreatedDkim) {
      return dnsAction(normalized, 'configure_mail', records,
        'In Namecheap, add the MX, SPF, and DKIM records shown here. Ask before removing any existing MX records. Then call continue_email_setup.');
    }

    const results = await Promise.allSettled([
      zoho.verifyMx(normalized),
      zoho.verifySpf(normalized),
      zoho.verifyDkim(normalized, dkim.dkimId)
    ]);
    const pending = results.some((result) => result.status === 'rejected' || result.value === false);
    return {
      status: pending ? 'propagation_pending' : 'ready_for_mailbox',
      domain: normalized,
      ...(pending ? { records, namecheapUrl: namecheapAdvancedDnsUrl(normalized) } : {}),
      nextAction: pending
        ? 'Check the records in the open Namecheap Advanced DNS page, wait for propagation, then retry continue_email_setup.'
        : 'The domain is ready. Create the mailbox with create_mailbox or repeat create_custom_email with confirm=true.'
    };
  }

  async status(domain: string) {
    const normalized = normalizeDomain(domain);
    const zoho = this.client();
    const zohoDomain = await zoho.getDomain(normalized);
    const setup = this.store.getDomainSetup(this.userId, normalized);
    const required = zohoDomain?.verificationStatus
      ? [...zoho.getMailRecords().mx, zoho.getMailRecords().spf, ...(setup.dkim ? [dkimRecord(setup.dkim.selector, setup.dkim.publicKey)] : [])]
      : zohoDomain?.cnameVerificationCode ? [verificationRecord(zohoDomain.cnameVerificationCode)] : [];
    return {
      domain: normalized,
      addedToZoho: Boolean(zohoDomain),
      domainVerified: Boolean(zohoDomain?.verificationStatus),
      mxVerified: Boolean(zohoDomain?.mxStatus),
      spfVerified: Boolean(zohoDomain?.spfStatus),
      dkimConfigured: Boolean(setup.dkim),
      dkimVerified: Boolean(zohoDomain?.dkimStatus),
      recordsRequired: required,
      namecheapUrl: namecheapAdvancedDnsUrl(normalized),
      note: 'This is Zoho state only. Use continue_email_setup after the records are present to ask Zoho to verify them.'
    };
  }

  async createMailbox(input: { domain: string; localPart: string; firstName: string; lastName?: string; displayName?: string }) {
    const domain = normalizeDomain(input.domain);
    const localPart = input.localPart.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(localPart)) throw new AppError('The mailbox name is invalid.', 'configuration');
    const zoho = this.client();
    const zohoDomain = await zoho.getDomain(domain);
    if (!zohoDomain?.verificationStatus) throw new AppError('The domain must be verified before creating a mailbox.', 'configuration');
    const email = `${localPart}@${domain}`;
    const password = generatePassword();
    const result = await zoho.createMailbox({ email, password, firstName: input.firstName, lastName: input.lastName, displayName: input.displayName });
    if (!result.created) {
      return {
        status: 'already_exists',
        email,
        accountId: result.account.accountId,
        nextAction: 'No changes were made. Use Zoho Mail to sign in or reset this mailbox password.'
      };
    }
    const secretCode = await this.store.createOneTimeSecret(this.userId, password);
    return {
      status: 'created',
      email,
      accountId: result.account.accountId,
      passwordUrl: `${this.workflowConfig.publicUrl}/secret/${secretCode}`,
      passwordExpiresInMinutes: 15,
      nextAction: 'Open the secure password link once, then sign in to Zoho Mail and change the temporary password.'
    };
  }

  private client(): ZohoClient {
    const connections: ProviderConnections = this.store.getConnections(this.userId);
    if (!connections.zoho) throw new AppError('Connect Zoho first with start_setup.', 'authentication');
    return new ZohoClient(connections.zoho, { clientId: this.workflowConfig.zohoClientId, clientSecret: this.workflowConfig.zohoClientSecret });
  }
}

function dnsAction(domain: string, phase: 'verify_domain' | 'configure_mail', records: DnsRecord[], nextAction: string) {
  return {
    status: 'namecheap_action_required',
    phase,
    domain,
    namecheapUrl: namecheapAdvancedDnsUrl(domain),
    records,
    nextAction,
    browserInstruction: 'Ask the user to open this Namecheap URL in their browser. If the AI host has browser control and the user authorizes the DNS change, enter the records for them; otherwise show the records in a compact copyable table.'
  };
}

export function namecheapAdvancedDnsUrl(domain: string): string {
  return `https://ap.www.namecheap.com/domains/domaincontrolpanel/${encodeURIComponent(domain)}/advancedns`;
}

function verificationRecord(code: string): DnsRecord {
  return { host: code, type: 'CNAME', value: 'zmverify.zoho.com', ttl: 1800 };
}

function dkimRecord(selector: string, publicKey: string): DnsRecord {
  return { host: `${selector}._domainkey`, type: 'TXT', value: publicKey, ttl: 1800 };
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}$/.test(normalized)) throw new AppError('Enter a valid root domain.', 'configuration');
  return normalized;
}

function generatePassword(): string {
  return `A9!${randomBytes(18).toString('base64url')}z`;
}

function connectionResult(result: PromiseSettledResult<void>) {
  return result.status === 'fulfilled'
    ? { connected: true as const }
    : { connected: false as const, ...safeConnectionError(result.reason) };
}

function safeConnectionError(error: unknown) {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: 'provider_error', message: 'Connection validation failed.' };
}
