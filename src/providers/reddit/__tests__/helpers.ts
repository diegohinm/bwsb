import { buildRedditDataConfig, type RedditDataConfig } from "../../../config/redditDataConfig.js";
import { RedditProviderError } from "../providerErrors.js";
import type { RedditDataProvider } from "../RedditDataProvider.js";
import type {
  NormalizedRedditComment,
  NormalizedRedditPost,
  RedditProviderName,
} from "../types.js";

/**
 * Shared test scaffolding for the Reddit provider layer.
 *
 * IMPORTANT: importing anything under src/config or src/providers pulls in
 * config/env.ts, which exits the process when required variables are missing.
 * Test files import THIS module first so the minimum viable environment is in
 * place before that happens; a real `.env` still wins.
 */

for (const [key, value] of Object.entries({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  NODE_ENV: "test",
})) {
  if (!process.env[key]) process.env[key] = value;
}

/**
 * DATABASE_URL is FORCED to an unreachable local address.
 *
 * The developer `.env` points at the real Supabase instance. Without this
 * override, any test that reaches a Prisma call would read — or write — the
 * production database. A refused connection is the correct outcome for a unit
 * test: it proves the persistence path was taken without touching real data.
 *
 * Must run before `lib/prisma.ts` is evaluated; test files import this module
 * first, and ESM finishes evaluating it before their remaining imports.
 */
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/testdb";

/**
 * Retry/backoff knobs are FORCED, not defaulted.
 *
 * Code paths that resolve the process configuration themselves (the scanner
 * controller does) would otherwise inherit the real `.env` — 3 retries with a
 * 5s base backoff turns a single failure-path assertion into a 35-second test.
 * Tests assert behaviour, never patience.
 */
process.env.REDDIT_PROVIDER_MAX_RETRIES = "0";
process.env.REDDIT_PROVIDER_RETRY_DELAY_MS = "100";
process.env.REDDIT_PROVIDER_TIMEOUT_MS = "2000";

/** A config built from explicit values only — never from the real environment. */
export function testConfig(
  overrides: Record<string, string> = {},
): RedditDataConfig {
  return buildRedditDataConfig({
    REDDIT_DATA_MODE: "hybrid",
    REDDIT_PRIMARY_PROVIDER: "arctic_shift",
    REDDIT_FALLBACK_PROVIDER: "mindcase",
    REDDIT_ENABLE_MINDCASE: "true",
    REDDIT_ENABLE_ARCTIC_SHIFT: "true",
    REDDIT_PROVIDER_TIMEOUT_MS: "1000",
    REDDIT_PROVIDER_MAX_RETRIES: "0",
    REDDIT_PROVIDER_RETRY_DELAY_MS: "100",
    MINDCASE_API_KEY: TEST_API_KEY,
    MINDCASE_BASE_URL: "https://api.mindcase.test",
    MINDCASE_POLL_INTERVAL_MS: "250",
    MINDCASE_MAX_POLL_ATTEMPTS: "2",
    ARCTIC_SHIFT_BASE_URL: "https://arctic.test",
    ARCTIC_SHIFT_REQUEST_DELAY_MS: "0",
    ...overrides,
  });
}

/** A recognizable secret, so a leak into a log line is unmistakable. */
export const TEST_API_KEY = "sk-test-SUPERSECRET-abc123";

export function makePost(
  overrides: Partial<NormalizedRedditPost> & {
    externalId: string;
    primarySource: RedditProviderName;
  },
): NormalizedRedditPost {
  const source = overrides.primarySource;
  return {
    fullname: `t3_${overrides.externalId}`,
    subreddit: "wallstreetbets",
    author: "trader",
    title: "",
    body: null,
    permalink: `/r/wallstreetbets/comments/${overrides.externalId}/`,
    url: null,
    score: 0,
    upvoteRatio: null,
    commentCount: 0,
    createdAt: new Date("2026-07-30T12:00:00.000Z"),
    fetchedAt: new Date("2026-07-30T13:00:00.000Z"),
    sources: [source],
    ...overrides,
  };
}

export function makeComment(
  overrides: Partial<NormalizedRedditComment> & {
    externalId: string;
    primarySource: RedditProviderName;
  },
): NormalizedRedditComment {
  const source = overrides.primarySource;
  return {
    fullname: `t1_${overrides.externalId}`,
    postId: "abc123",
    parentId: "t3_abc123",
    subreddit: "wallstreetbets",
    author: "trader",
    body: null,
    permalink: null,
    score: 0,
    createdAt: new Date("2026-07-30T12:00:00.000Z"),
    fetchedAt: new Date("2026-07-30T13:00:00.000Z"),
    sources: [source],
    ...overrides,
  };
}

export interface StubProvider extends RedditDataProvider {
  postCalls: number;
  commentCalls: number;
}

/** A provider that returns fixed records and counts how often it was asked. */
export function stubProvider(
  name: RedditProviderName,
  behaviour: {
    posts?: NormalizedRedditPost[];
    comments?: NormalizedRedditComment[];
    error?: unknown;
    available?: boolean;
  } = {},
): StubProvider {
  const provider: StubProvider = {
    name,
    postCalls: 0,
    commentCalls: 0,
    isAvailable: () => behaviour.available ?? true,
    async fetchPosts() {
      provider.postCalls += 1;
      if (behaviour.error) throw behaviour.error;
      return behaviour.posts ?? [];
    },
    async fetchComments() {
      provider.commentCalls += 1;
      if (behaviour.error) throw behaviour.error;
      return behaviour.comments ?? [];
    },
  };
  return provider;
}

export function providerError(
  name: RedditProviderName,
  kind: ConstructorParameters<typeof RedditProviderError>[1],
  status?: number,
): RedditProviderError {
  return new RedditProviderError(name, kind, `${name} ${kind}`, status);
}

/** Capture console output for the duration of `run`. */
export async function captureConsole(
  run: () => Promise<void>,
): Promise<string> {
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const record =
    (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };

  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines.join("\n");
}

/** One recorded outgoing request: enough to assert on URL *and* payload. */
export interface StubbedRequest {
  url: string;
  method: string;
  /** Parsed JSON body, or undefined for a bodyless request. */
  body: unknown;
}

/** Replace global fetch with a scripted responder; records what was sent. */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown },
): { urls: string[]; requests: StubbedRequest[]; restore: () => void } {
  const urls: string[] = [];
  const requests: StubbedRequest[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    urls.push(url);
    let parsed: unknown;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    requests.push({ url, method: init?.method ?? "GET", body: parsed });

    const { status = 200, body = {} } = handler(url, init);
    // `text()` as well as `json()`: the HTTP client reads error bodies as text
    // before parsing them, exactly as a real Response allows.
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => serialized,
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  return { urls, requests, restore: () => { globalThis.fetch = original; } };
}
