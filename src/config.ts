import { createHash } from 'node:crypto';
import type { ZohoDataCenter } from './types.js';

try {
  process.loadEnvFile();
} catch {
  // Environment variables may be supplied by the hosting platform.
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}

const configuredKey = process.env.MASTER_ENCRYPTION_KEY;
const encryptionKey = configuredKey
  ? Buffer.from(configuredKey, 'base64')
  : createHash('sha256').update('custom-email-development-only-key').digest();

if (encryptionKey.length !== 32) {
  throw new Error('MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes.');
}

export const config = {
  port,
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  userId: 'local-development-user',
  encryptionKey,
  usingDerivedEncryptionKey: !configuredKey,
  dataFile: process.env.DATA_FILE ?? '.data/state.json',
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID ?? '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET ?? '',
    dataCenter: (process.env.ZOHO_DATA_CENTER ?? 'com') as ZohoDataCenter
  }
};
