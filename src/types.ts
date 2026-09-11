export type DnsRecordType = 'A' | 'AAAA' | 'ALIAS' | 'CAA' | 'CNAME' | 'MX' | 'MXE' | 'NS' | 'TXT' | 'URL' | 'URL301' | 'FRAME';

export interface DnsRecord {
  host: string;
  type: DnsRecordType;
  value: string;
  ttl?: number;
  mxPriority?: number;
}

export interface ZohoConnection {
  refreshToken: string;
  orgId: string;
  dataCenter: ZohoDataCenter;
}

export type ZohoDataCenter = 'com' | 'eu' | 'in' | 'com.au' | 'jp' | 'ca' | 'com.cn' | 'ae' | 'sa';

export interface ProviderConnections {
  zoho?: ZohoConnection;
}

export interface OnboardingSession {
  code: string;
  userId: string;
  expiresAt: number;
}

export interface StoredState {
  version: 2;
  users: Record<string, { encryptedConnections?: string; setup?: Record<string, DomainSetupState> }>;
  onboarding: Record<string, OnboardingSession>;
  oneTimeSecrets?: Record<string, { userId: string; encryptedValue: string; expiresAt: number }>;
  oauth?: OAuthState;
}

export interface OAuthState {
  clients: Record<string, OAuthClient>;
  authorizationRequests: Record<string, OAuthAuthorizationRequest>;
  authorizationCodes: Record<string, OAuthAuthorizationCode>;
  accessTokens: Record<string, OAuthTokenRecord>;
  refreshTokens: Record<string, OAuthTokenRecord>;
}

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

export interface OAuthAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string[];
  resource: string;
  expiresAt: number;
}

export interface OAuthAuthorizationCode extends OAuthAuthorizationRequest {
  userId: string;
}

export interface OAuthTokenRecord {
  userId: string;
  clientId: string;
  scope: string[];
  resource: string;
  expiresAt: number;
}

export interface DomainSetupState {
  dkim?: DkimDetails;
}

export interface ZohoDomain {
  domainName: string;
  verificationStatus: boolean;
  cnameVerificationCode?: string;
  mxStatus?: boolean;
  spfStatus?: boolean;
  dkimStatus?: boolean;
}

export interface DkimDetails {
  selector: string;
  publicKey: string;
  dkimId: string;
}
