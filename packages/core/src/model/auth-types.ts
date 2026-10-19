import type { KeyValue } from '@testpion/shared';

/**
 * The auth a request, folder or collection can carry (what `AuthConfig.type` can be). In its own file so the model's
 * main file stays small; `model/types.ts` re-exports it.
 */
export type AuthConfig =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'apiKey'; key: string; value: string; in: 'header' | 'query' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string; prefix?: string }
  | {
      type: 'jwt';
      secret: string;
      algorithm?: 'HS256' | 'HS384' | 'HS512';
      /** JSON payload (templated). `iat`/`exp` are added when `expiresInSec` is set. */
      payload: string;
      expiresInSec?: number;
      prefix?: string;
    }
  | {
      type: 'oauth2';
      grantType: 'client_credentials' | 'password' | 'authorization_code';
      tokenUrl: string;
      authUrl?: string;
      clientId: string;
      clientSecret?: string;
      scope?: string;
      audience?: string;
      username?: string;
      password?: string;
      usePkce?: boolean;
      redirectPort?: number;
      /** Callback URL registered with the provider, e.g. http://localhost:8080/oauth/callback (a loopback address). Default: http://127.0.0.1:<any port>/callback */
      redirectUri?: string;
      /** How the client id and secret are sent to the token URL: in the form body (default) or as an HTTP Basic header. */
      clientAuth?: 'body' | 'header';
    }
  | { type: 'headers'; headers: KeyValue[] }
  /** HTTP Digest (RFC 7616): the first request gets the server's challenge, the second answers it. */
  | { type: 'digest'; username: string; password: string }
  /** AWS Signature Version 4 (API Gateway, S3, Lambda URLs, any AWS API). */
  | { type: 'awsv4'; accessKey: string; secretKey: string; sessionToken?: string; region: string; service: string }
  /** OAuth 1.0a (RFC 5849), signed per request. */
  | { type: 'oauth1'; consumerKey: string; consumerSecret: string; token?: string; tokenSecret?: string; signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT'; realm?: string; addTo?: 'header' | 'query' }
  /** Windows NTLM (v2): a three-message handshake on one connection (IIS, Exchange, SharePoint, many corporate proxies). */
  | { type: 'ntlm'; username: string; password: string; domain?: string; workstation?: string }
  /** Hawk (HTTP holder-of-key): a MAC over the method, host, path and (optionally) the payload. */
  | { type: 'hawk'; id: string; key: string; algorithm?: 'sha256' | 'sha1'; ext?: string; app?: string; dlg?: string; includePayloadHash?: boolean }
  /** Akamai EdgeGrid (EG1-HMAC-SHA256): the client token, access token and client secret of an API client. */
  | { type: 'edgegrid'; clientToken: string; clientSecret: string; accessToken: string; headersToSign?: string; maxBodySize?: number };
