/**
 * inspectMindcaseAgent.ts
 *
 * Ask the Mindcase account what its `reddit/posts` agent actually expects.
 *
 * WHY
 * The input field is account-specific: this one answers a `startUrls` payload
 * with `422 "This agent needs input. Provide one of: URL"`. The provider sends
 * ONE payload shape and never probes alternatives — starting speculative jobs
 * against a metered API is how credits disappear — so when the contract changes
 * this script is the way to see it, on demand and read-only.
 *
 * SAFETY
 *   - GET requests only. No job is created, no credits are spent.
 *   - The API key is read from MINDCASE_API_KEY, sent in the Authorization
 *     header, and never printed.
 *   - Exits non-zero when the declared contract does not include the field the
 *     provider sends, so it is usable as a pre-deploy check.
 *
 * Usage:
 *   npm run mindcase:agent
 */
import "dotenv/config";

import { buildRedditDataConfig } from "../config/redditDataConfig.js";
import { MindcaseProvider } from "../providers/reddit/MindcaseProvider.js";
import { AGENT_INPUT_FIELD } from "../providers/reddit/mindcaseRedditRequest.js";
import { sanitizeProviderError } from "../providers/reddit/providerErrors.js";

async function main(): Promise<void> {
  const provider = new MindcaseProvider(buildRedditDataConfig());

  if (!provider.isAvailable()) {
    console.error(
      "Mindcase is not configured. Set MINDCASE_API_KEY (and MINDCASE_BASE_URL) first.",
    );
    process.exitCode = 1;
    return;
  }

  const definition = await provider.describeAgent();

  if (!definition) {
    console.error(
      "The account published no readable agent definition. " +
        `The provider will keep sending "${AGENT_INPUT_FIELD}"; a 422 naming a ` +
        "different field is the signal to change it in mindcaseRedditRequest.ts.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("reddit/posts agent");
  console.log(`  requiredParams : ${definition.requiredParams.join(", ") || "(none declared)"}`);
  console.log(`  allParams      : ${definition.allParams.join(", ") || "(none declared)"}`);
  console.log(`  we send        : ${AGENT_INPUT_FIELD}`);
  console.log(
    `  verdict        : ${
      definition.matchesConfiguredInputField
        ? "OK — the field we send is part of the declared contract."
        : `MISMATCH — update AGENT_INPUT_FIELD in providers/reddit/mindcaseRedditRequest.ts.`
    }`,
  );
  console.log("");

  if (!definition.matchesConfiguredInputField) process.exitCode = 1;
}

main().catch((error) => {
  // Sanitized: this runs with a real key in the environment.
  console.error(`Agent inspection failed: ${sanitizeProviderError(error)}`);
  process.exitCode = 1;
});
