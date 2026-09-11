import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decryptJson, encryptJson } from './crypto.js';
import type {
  DomainSetupState,
  OAuthAuthorizationCode,
  OAuthAuthorizationRequest,
  OAuthClient,
  OAuthTokenRecord,
  OnboardingSession,
  ProviderConnections,
  StoredState
} from './types.js';

const EMPTY_STATE: StoredState = { version: 2, users: {}, onboarding: {} };

export class FileStore {
  private state: StoredState = structuredClone(EMPTY_STATE);
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly key: Buffer) {}

  async init(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.path, 'utf8')) as StoredState;
      this.state.version = 2;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist();
    }
    this.pruneExpiredSessions();
  }

  getConnections(userId: string): ProviderConnections {
    const encrypted = this.state.users[userId]?.encryptedConnections;
    return encrypted ? decryptJson<ProviderConnections>(encrypted, this.key) : {};
  }

  async saveConnections(userId: string, connections: ProviderConnections): Promise<void> {
    this.state.users[userId] = { ...this.state.users[userId], encryptedConnections: encryptJson(connections, this.key) };
    await this.persist();
  }

  getDomainSetup(userId: string, domain: string): DomainSetupState {
    return this.state.users[userId]?.setup?.[domain.toLowerCase()] ?? {};
  }

  async saveDomainSetup(userId: string, domain: string, setup: DomainSetupState): Promise<void> {
    const user = this.state.users[userId] ?? {};
    user.setup = { ...user.setup, [domain.toLowerCase()]: setup };
    this.state.users[userId] = user;
    await this.persist();
  }

  async createOnboarding(userId: string, ttlMinutes = 15): Promise<OnboardingSession> {
    this.pruneExpiredSessions();
    const session: OnboardingSession = {
      code: randomBytes(24).toString('base64url'),
      userId,
      expiresAt: Date.now() + ttlMinutes * 60_000
    };
    this.state.onboarding[session.code] = session;
    await this.persist();
    return session;
  }

  async createOneTimeSecret(userId: string, value: string, ttlMinutes = 15): Promise<string> {
    const code = randomBytes(24).toString('base64url');
    this.state.oneTimeSecrets ??= {};
    this.state.oneTimeSecrets[code] = {
      userId,
      encryptedValue: encryptJson(value, this.key),
      expiresAt: Date.now() + ttlMinutes * 60_000
    };
    await this.persist();
    return code;
  }

  async consumeOneTimeSecret(code: string): Promise<string | undefined> {
    const secret = this.state.oneTimeSecrets?.[code];
    if (!secret || secret.expiresAt <= Date.now()) return undefined;
    delete this.state.oneTimeSecrets?.[code];
    await this.persist();
    return decryptJson<string>(secret.encryptedValue, this.key);
  }

  findOnboarding(code: string): OnboardingSession | undefined {
    const session = this.state.onboarding[code];
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return session;
  }

  async consumeOnboarding(code: string): Promise<void> {
    delete this.state.onboarding[code];
    await this.persist();
  }

  async registerOAuthClient(input: Pick<OAuthClient, 'redirectUris' | 'clientName'>): Promise<OAuthClient> {
    const client: OAuthClient = {
      clientId: randomBytes(24).toString('base64url'),
      redirectUris: input.redirectUris,
      ...(input.clientName ? { clientName: input.clientName } : {}),
      createdAt: Date.now()
    };
    this.oauth().clients[client.clientId] = client;
    await this.persist();
    return client;
  }

  getOAuthClient(clientId: string): OAuthClient | undefined {
    return this.oauth().clients[clientId];
  }

  async createOAuthAuthorizationRequest(request: OAuthAuthorizationRequest): Promise<string> {
    this.pruneExpiredSessions();
    const id = randomBytes(24).toString('base64url');
    this.oauth().authorizationRequests[hashSecret(id)] = request;
    await this.persist();
    return id;
  }

  async consumeOAuthAuthorizationRequest(id: string): Promise<OAuthAuthorizationRequest | undefined> {
    const key = hashSecret(id);
    const request = this.oauth().authorizationRequests[key];
    delete this.oauth().authorizationRequests[key];
    await this.persist();
    return request?.expiresAt && request.expiresAt > Date.now() ? request : undefined;
  }

  async createOAuthAuthorizationCode(code: OAuthAuthorizationCode): Promise<string> {
    const value = randomBytes(32).toString('base64url');
    this.oauth().authorizationCodes[hashSecret(value)] = code;
    await this.persist();
    return value;
  }

  async consumeOAuthAuthorizationCode(value: string): Promise<OAuthAuthorizationCode | undefined> {
    const key = hashSecret(value);
    const code = this.oauth().authorizationCodes[key];
    delete this.oauth().authorizationCodes[key];
    await this.persist();
    return code?.expiresAt && code.expiresAt > Date.now() ? code : undefined;
  }

  async issueOAuthTokens(record: Omit<OAuthTokenRecord, 'expiresAt'>): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    this.pruneExpiredSessions();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(40).toString('base64url');
    const expiresIn = 3600;
    this.oauth().accessTokens[hashSecret(accessToken)] = { ...record, expiresAt: Date.now() + expiresIn * 1000 };
    this.oauth().refreshTokens[hashSecret(refreshToken)] = { ...record, expiresAt: Date.now() + 90 * 24 * 60 * 60_000 };
    await this.persist();
    return { accessToken, refreshToken, expiresIn };
  }

  getOAuthAccessToken(value: string): OAuthTokenRecord | undefined {
    const token = this.oauth().accessTokens[hashSecret(value)];
    return token?.expiresAt && token.expiresAt > Date.now() ? token : undefined;
  }

  async rotateOAuthRefreshToken(value: string): Promise<{ record: OAuthTokenRecord; accessToken: string; refreshToken: string; expiresIn: number } | undefined> {
    const key = hashSecret(value);
    const record = this.oauth().refreshTokens[key];
    delete this.oauth().refreshTokens[key];
    if (!record || record.expiresAt <= Date.now()) {
      await this.persist();
      return undefined;
    }
    const tokens = await this.issueOAuthTokens({
      userId: record.userId,
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource
    });
    return { record, ...tokens };
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [code, session] of Object.entries(this.state.onboarding)) {
      if (session.expiresAt <= now) delete this.state.onboarding[code];
    }
    for (const [code, secret] of Object.entries(this.state.oneTimeSecrets ?? {})) {
      if (secret.expiresAt <= now) delete this.state.oneTimeSecrets?.[code];
    }
    const oauth = this.oauth();
    for (const collection of [oauth.authorizationRequests, oauth.authorizationCodes, oauth.accessTokens, oauth.refreshTokens]) {
      for (const [key, value] of Object.entries(collection)) {
        if (value.expiresAt <= now) delete collection[key];
      }
    }
  }

  private oauth() {
    return this.state.oauth ??= {
      clients: {}, authorizationRequests: {}, authorizationCodes: {}, accessTokens: {}, refreshTokens: {}
    };
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    });
    await this.writeChain;
  }
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
