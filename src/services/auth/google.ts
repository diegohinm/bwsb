import { randomBytes } from "node:crypto";
import { env, isGoogleOAuthConfigured } from "../../config/env.js";

/**
 * Google OAuth 2.0 (Authorization Code flow, OpenID Connect).
 *
 * All Google OAuth logic lives in the backend. The client secret, access
 * tokens, and identity responses never leave the server. See the Google docs:
 * https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * OAuth is OPTIONAL: the credentials are only present when configured. Every
 * function that needs them calls getGoogleConfig(), which throws if the app is
 * not configured. Callers (routes) gate on isGoogleOAuthConfigured first.
 */

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read the fully-populated Google OAuth config, or throw if not configured. */
function getGoogleConfig(): GoogleConfig {
  if (
    !isGoogleOAuthConfigured ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REDIRECT_URI
  ) {
    throw new Error("Google OAuth is not configured");
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

/** Generate a cryptographically random `state` value for CSRF protection. */
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Build the Google authorization URL the user's browser is redirected to.
 * Scope `openid email profile`. `prompt=select_account` lets the user pick which
 * Google account to use. We do not request offline access — we read the identity
 * once and then rely on our own yt_session.
 */
export function buildAuthorizeUrl(state: string): string {
  const cfg = getGoogleConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    state,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "select_account",
  });

  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/** Shape of the identity fields we consume from the OIDC userinfo endpoint. */
export interface GoogleIdentity {
  /** Stable Google account id (the OIDC `sub` claim). */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/**
 * Exchange an authorization `code` for a Google access token. Returns the raw
 * access token, which is used exactly once (to fetch identity) and then
 * discarded — it is never persisted or sent to the client.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const cfg = getGoogleConfig();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Google token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error || !data.access_token) {
    throw new Error(
      `Google token exchange returned an error: ${data.error_description ?? data.error ?? "no access_token"}`,
    );
  }

  return data.access_token;
}

/**
 * Fetch the authenticated Google user's identity from the OIDC userinfo
 * endpoint. The access token is passed as a Bearer token and is not stored.
 */
export async function fetchGoogleIdentity(
  accessToken: string,
): Promise<GoogleIdentity> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Google identity request failed: ${response.status} ${response.statusText}`,
    );
  }

  const raw = (await response.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
    picture?: string;
  };

  if (!raw.sub || !raw.email) {
    throw new Error("Google identity response is missing sub or email");
  }

  return {
    sub: raw.sub,
    email: raw.email,
    // Google may return the boolean as a string ("true").
    emailVerified: raw.email_verified === true || raw.email_verified === "true",
    name: raw.name,
    picture: raw.picture,
  };
}
