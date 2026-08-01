/**
 * The wire contract of Mindcase's `reddit/posts` agent.
 *
 * WHY THIS FILE EXISTS
 * The app speaks a normalized dialect internally — `{ provider, subreddit,
 * sort, limit, persist }` from the scanner page, `RedditFetchPostsInput` inside
 * the provider layer. Mindcase's agent speaks a different one, and sending ours
 * verbatim is what produced HTTP 422:
 *
 *   ours       { provider, subreddit, sort, limit, persist }
 *   Mindcase   { URL, maxItems, maxPostCount, maxComments, skipComments, sort }
 *
 * THE INPUT FIELD IS `URL`, A STRING — NOT `startUrls`
 * The agent connected to this account answers a `startUrls` payload with
 *
 *   422  "This agent needs input. Provide one of: URL"
 *
 * so the crawl target is sent as a single string under `URL`, and `startUrls`
 * is never sent alongside it: an agent that accepts both would otherwise
 * receive two conflicting inputs. This is the CURRENT account's contract, not a
 * universal one — `MindcaseProvider.describeAgent()` reports what the live
 * account actually declares.
 *
 * Everything here is PURE — no config, no env, no HTTP — so the translation can
 * be asserted directly in tests without a network stub, and so no internal
 * field can leak upstream by accident: the payload is built by listing the
 * fields Mindcase accepts, never by spreading the caller's object.
 */

/** Sorts the agent accepts. Anything else falls back to `new`. */
export const MINDCASE_SORTS = ["new", "hot", "top"] as const;
export type MindcaseSort = (typeof MINDCASE_SORTS)[number];

/** The agent rejects 0 and refuses to bill for more than 100 per run. */
export const MIN_ITEM_COUNT = 1;
export const MAX_ITEM_COUNT = 100;
/** Used when the caller does not ask for a specific size. */
export const DEFAULT_ITEM_COUNT = 25;

/** The field this account's agent reads its crawl target from. */
export const AGENT_INPUT_FIELD = "URL" as const;

/** Exactly what goes on the wire — no more fields, no fewer. */
export interface RedditPostsAgentPayload {
  /** A single listing URL as a STRING. Never an array, never `startUrls`. */
  URL: string;
  maxItems: number;
  maxPostCount: number;
  /** A posts scan never pays for comment expansion. */
  maxComments: number;
  skipComments: boolean;
  sort: MindcaseSort;
}

export interface RedditPostsPayloadInput {
  subreddit: string;
  sort?: string | undefined;
  limit?: number | undefined;
}

/**
 * `r/WallStreetBets`, `/r/wallstreetbets/`, ` WALLSTREETBETS ` → `wallstreetbets`.
 *
 * Reddit treats subreddit names case-insensitively but the agent builds a URL
 * out of this string, so it is lowercased once here rather than in three call
 * sites.
 */
export function normalizeSubredditName(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, "")
    .replace(/^r\//i, "")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

/** Any sort the agent does not know becomes `new`. */
export function normalizeSort(value: string | undefined): MindcaseSort {
  const lowered = value?.trim().toLowerCase();
  return (MINDCASE_SORTS as readonly string[]).includes(lowered ?? "")
    ? (lowered as MindcaseSort)
    : "new";
}

/** Clamp into [1, 100]; a missing or unusable value becomes the default. */
export function clampItemCount(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ITEM_COUNT;
  return Math.max(MIN_ITEM_COUNT, Math.min(MAX_ITEM_COUNT, Math.trunc(limit)));
}

/**
 * `wallstreetbets` + `new` → `https://www.reddit.com/r/wallstreetbets/new/`.
 *
 * The sort is part of the PATH, not a query parameter: `/new/`, `/hot/`,
 * `/top/` are the listings Reddit serves, and the agent crawls whatever URL it
 * is handed.
 */
export function buildSubredditUrl(subreddit: string, sort: MindcaseSort): string {
  return `https://www.reddit.com/r/${normalizeSubredditName(subreddit)}/${sort}/`;
}

/**
 * Normalized input → agent payload.
 *
 * `provider`, `subreddit`, `limit`, `persist` and `includeRaw` are internal
 * routing/UI concerns; they are deliberately absent from the result.
 */
export function buildRedditPostsPayload(
  input: RedditPostsPayloadInput,
): RedditPostsAgentPayload {
  const subreddit = normalizeSubredditName(input.subreddit);
  const sort = normalizeSort(input.sort);
  const count = clampItemCount(input.limit);

  return {
    URL: buildSubredditUrl(subreddit, sort),
    maxItems: count,
    // The agent uses maxItems for the crawl budget and maxPostCount for the
    // post cap; sending only one of them yields either 422 or a short page.
    maxPostCount: count,
    maxComments: 0,
    skipComments: true,
    sort,
  };
}

/** The one-line, credential-free summary logged before a job is created. */
export interface RedditPostsRunLog {
  agent: "reddit/posts";
  inputField: typeof AGENT_INPUT_FIELD;
  url: string;
  maxItems: number;
  sort: MindcaseSort;
}

export function describeRun(payload: RedditPostsAgentPayload): RedditPostsRunLog {
  return {
    agent: "reddit/posts",
    inputField: AGENT_INPUT_FIELD,
    url: payload.URL,
    maxItems: payload.maxItems,
    sort: payload.sort,
  };
}

// ── 422 response reading ─────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** `["body", "params"]` → `body.params`, for pinpointing the rejected field. */
function locationOf(entry: Json): string | undefined {
  const loc = entry.loc ?? entry.path ?? entry.field;
  if (Array.isArray(loc)) {
    const parts = loc.filter((p) => typeof p === "string" || typeof p === "number");
    return parts.length > 0 ? parts.join(".") : undefined;
  }
  return text(loc);
}

function describeEntry(entry: unknown): string | undefined {
  const record = asRecord(entry);
  if (!record) return text(entry);

  const message = text(record.msg) ?? text(record.message) ?? text(record.detail);
  if (!message) return undefined;
  const where = locationOf(record);
  return where ? `${message} (${where})` : message;
}

/**
 * Pull the human part out of a validation body.
 *
 * Covers the shapes seen from this API and the frameworks behind it:
 *   { detail: [{ loc: ["body","URL"], msg: "Field required" }] }        (FastAPI)
 *   { detail: "This agent needs input. Provide one of: URL" }
 *   { message: "..." } / { error: "..." } / { error: { message: "..." } }
 *   { errors: [{ message: "..." }] }
 *
 * Returns undefined when nothing readable is present, so callers can fall back
 * to a generic sentence instead of printing `[object Object]`.
 */
export function extractValidationMessage(body: unknown): string | undefined {
  if (typeof body === "string") return text(body);

  const record = asRecord(body);
  if (!record) return undefined;

  for (const candidate of [record.detail, record.errors, record.error, record.message]) {
    if (Array.isArray(candidate)) {
      const parts = candidate
        .map(describeEntry)
        .filter((part): part is string => Boolean(part));
      if (parts.length > 0) return parts.join("; ");
      continue;
    }
    const described = describeEntry(candidate);
    if (described) return described;
  }

  return undefined;
}

/**
 * The input field names a rejection asks for.
 *
 * "This agent needs input. Provide one of: URL" → ["URL"]. Purely diagnostic:
 * it turns a 422 into a hint the operator can act on, and NOTHING re-sends a
 * payload because of it — see `MindcaseProvider.runPostsJob`.
 */
export function suggestedInputFields(body: unknown): string[] {
  const message = extractValidationMessage(body) ?? "";
  const match = /provide one of[:\s]+([^.\n]+)/i.exec(message);
  if (!match?.[1]) return [];
  return match[1]
    .split(/[,/|]| or /i)
    .map((part) => part.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter((part) => part.length > 0 && part.length <= 40);
}

// ── agent definition (development diagnostics) ───────────────────────────────

/** What the live account declares its `reddit/posts` agent needs. */
export interface RedditPostsAgentDefinition {
  /** Field names the agent requires, when it publishes them. */
  requiredParams: string[];
  /** Every parameter name found, required or not. */
  allParams: string[];
  /** Whether the declared contract matches the payload this app sends. */
  matchesConfiguredInputField: boolean;
}

function paramNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const record = asRecord(entry);
        return record ? (text(record.name) ?? text(record.field) ?? text(record.key)) : undefined;
      })
      .filter((name): name is string => Boolean(name));
  }
  const record = asRecord(value);
  return record ? Object.keys(record) : [];
}

/**
 * Read an agent-definition payload without assuming one schema dialect.
 *
 * Accounts have been seen publishing `requiredParams`, `required_params`,
 * `required`, `inputs` and a JSON-Schema-ish `{ schema: { required, properties } }`.
 * Anything unrecognized yields empty lists rather than an error — this is a
 * diagnostic, and a diagnostic that throws is worse than one that says nothing.
 */
export function readAgentDefinition(payload: unknown): RedditPostsAgentDefinition {
  const root = asRecord(payload) ?? {};
  const agent = asRecord(root.agent) ?? asRecord(root.data) ?? root;
  const schema = asRecord(agent.schema) ?? asRecord(agent.inputSchema) ?? {};

  const required = new Set<string>([
    ...paramNames(agent.requiredParams),
    ...paramNames(agent.required_params),
    ...paramNames(agent.required),
    ...paramNames(schema.required),
  ]);

  const all = new Set<string>([
    ...required,
    ...paramNames(agent.params),
    ...paramNames(agent.parameters),
    ...paramNames(agent.inputs),
    ...paramNames(schema.properties),
  ]);

  return {
    requiredParams: [...required],
    allParams: [...all],
    matchesConfiguredInputField:
      all.size === 0 ? false : all.has(AGENT_INPUT_FIELD),
  };
}
