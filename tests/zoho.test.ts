import { describe, expect, it, vi } from 'vitest';
import { ZohoClient } from '../src/providers/zoho.js';

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Zoho domain responses', () => {
  it('reads the domainVO wrapper and lowercase verification status fields', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'access', expires_in: 3600 }))
      .mockResolvedValueOnce(response({
        status: { code: 200 },
        data: {
          domainVO: [{
            domainName: 'nkavo.com',
            verificationStatus: true,
            mxstatus: true,
            spfstatus: true,
            dkimstatus: false
          }]
        }
      }));
    const client = new ZohoClient(
      { refreshToken: 'refresh', orgId: 'org-1', dataCenter: 'com' },
      { clientId: 'client', clientSecret: 'secret' },
      fetcher
    );

    await expect(client.listDomains()).resolves.toEqual([{
      domainName: 'nkavo.com',
      verificationStatus: true,
      mxStatus: true,
      spfStatus: true,
      dkimStatus: false
    }]);
  });

  it('fetches a domain directly instead of depending on the list response', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'access', expires_in: 3600 }))
      .mockResolvedValueOnce(response({
        status: { code: 200 },
        data: { domainName: 'nkavo.com', verificationStatus: true }
      }));
    const client = new ZohoClient(
      { refreshToken: 'refresh', orgId: 'org-1', dataCenter: 'com' },
      { clientId: 'client', clientSecret: 'secret' },
      fetcher
    );

    await expect(client.getDomain('nkavo.com')).resolves.toEqual(expect.objectContaining({
      domainName: 'nkavo.com',
      verificationStatus: true
    }));
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://mail.zoho.com/api/organization/org-1/domains/nkavo.com',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
