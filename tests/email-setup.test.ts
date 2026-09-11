import { describe, expect, it } from 'vitest';
import { namecheapAdvancedDnsUrl } from '../src/workflows/email-setup.js';

describe('browser-assisted Namecheap setup', () => {
  it('opens the selected domain directly in Advanced DNS', () => {
    expect(namecheapAdvancedDnsUrl('example.com')).toBe(
      'https://ap.www.namecheap.com/domains/domaincontrolpanel/example.com/advancedns'
    );
  });
});
