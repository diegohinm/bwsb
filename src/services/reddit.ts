import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Reddit OAuth 2.0 (Authorization Code flow).
 *
 * All Reddit OAuth logic lives in the backend. The client secret, access
 * tokens, and identity responses never leave the server. See the Reddit docs:
 * https://github.com/reddit-archive/reddit/wiki/OAuth2
 */

const REDDIT_AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_IDENTITY_URL = "https://oauth.reddit.com/api/v1/me";

// Reddit requires a unique, descriptive User-Agent or it aggressively rate
// limits / blocks the request. Format: <platform>:<app id>:<version> (by /u/...).
// Sourced from env so it can be tuned per-deployment without a code change.
const USER_AGENT = env.REDDIT_USER_AGENT;

/** Generate a cryptographically random `state` value for CSRF protection. */
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Build the Reddit authorization URL the user's browser is redirected to.
 * Scope `identity`, `duration=temporary` (we do not want a refresh token — we
 * only read the identity once and then rely on our own session).
 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.REDDIT_CLIENT_ID,
    response_type: "code",
    state,
    redirect_uri: env.REDDIT_REDIRECT_URI,
    duration: "temporary",
    scope: "identity",
  });

  return `${REDDIT_AUTHORIZE_URL}?${params.toString()}`;
}

/** Shape of the identity fields we consume from GET /api/v1/me. */
export interface RedditIdentity {
  id: string;
  name: string;
  icon_img?: string;
  snoovatar_img?: string;
  created_utc?: number;
  has_verified_email?: boolean;
}

/**
 * Exchange an authorization `code` for a Reddit access token. Uses HTTP Basic
 * auth (client_id:client_secret) as required by Reddit. Returns the raw access
 * token, which is used exactly once (to fetch identity) and then discarded —
 * it is never persisted or sent to the client.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const basicAuth = Buffer.from(
    `${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`,
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.REDDIT_REDIRECT_URI,
  });

  const response = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Reddit token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
  };

  if (data.error || !data.access_token) {
    throw new Error(
      `Reddit token exchange returned an error: ${data.error ?? "no access_token"}`,
    );
  }

  return data.access_token;
}

/**
 * Fetch the authenticated Reddit user's identity. The access token is passed as
 * a Bearer token and is not stored anywhere.
 */
export async function fetchRedditIdentity(
  accessToken: string,
): Promise<RedditIdentity> {
  const response = await fetch(REDDIT_IDENTITY_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Reddit identity request failed: ${response.status} ${response.statusText}`,
    );
  }

  const identity = (await response.json()) as RedditIdentity;

  if (!identity.id || !identity.name) {
    throw new Error("Reddit identity response is missing id or name");
  }

  return identity;
}

/**
 * Reddit avatar URLs come HTML-escaped (&amp;) and sometimes with tracking
 * query params. Prefer the snoovatar, fall back to the icon, and clean it up.
 */
export function resolveAvatarUrl(identity: RedditIdentity): string | null {
  const raw = identity.snoovatar_img || identity.icon_img || "";
  if (!raw) return null;
  return raw.replace(/&amp;/g, "&").split("?")[0] ?? null;
}
