import { buildMockPulseSnapshot } from "./mock/pulseFixtures.js";
import type {
  PulseQuery,
  PulseSnapshot,
  SocialDataProvider,
} from "./types.js";

/**
 * DEMO provider. Serves centralized local fixtures — no network, no scraping.
 * Always available, so it doubles as the fallback whenever a configured
 * third-party provider is missing credentials or fails.
 */
export class MockSocialDataProvider implements SocialDataProvider {
  readonly name = "mock" as const;
  readonly isEnabled = true;

  async getPulse(query: PulseQuery): Promise<PulseSnapshot> {
    const snapshot = buildMockPulseSnapshot(
      query.timeframe,
      new Date().toISOString(),
    );
    return {
      ...snapshot,
      source: this.name,
      isDemo: true,
      fallbackReason: null,
    };
  }
}

export const mockSocialDataProvider = new MockSocialDataProvider();
