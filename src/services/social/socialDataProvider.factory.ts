import { env } from "../../config/env.js";
import { mockSocialDataProvider } from "./providers/mockSocialData.provider.js";
import { mindcaseSocialDataProvider } from "./providers/mindcaseSocialData.provider.js";
import { brandwatchSocialDataProvider } from "./providers/brandwatchSocialData.provider.js";
import { redditOfficialSocialDataProvider } from "./providers/redditOfficialSocialData.provider.js";
import type { SocialDataProvider } from "./socialData.provider.js";

/**
 * Resolve the configured social data provider from SOCIAL_DATA_PROVIDER.
 * Anything unrecognized (including `off`, which the service handles separately)
 * falls back to the mock provider so the app always has a working data source.
 */
export function getSocialDataProvider(): SocialDataProvider {
  switch (env.SOCIAL_DATA_PROVIDER) {
    case "mindcase":
      return mindcaseSocialDataProvider;
    case "brandwatch":
      return brandwatchSocialDataProvider;
    case "reddit_official":
      return redditOfficialSocialDataProvider;
    case "mock":
    default:
      return mockSocialDataProvider;
  }
}

export { mockSocialDataProvider };
