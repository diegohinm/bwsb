/**
 * attentionIndex.service.ts
 *
 * Computes our own proprietary Retail Attention Index from five normalized
 * components. This is NOT a "Fear & Greed" clone; it is a weighted blend that
 * describes how much retail attention a market/ticker is drawing. Deterministic.
 */

export interface AttentionComponents {
  stanceBalance: number; // 0..1
  breadth: number; // 0..1
  priceConfirmation: number; // 0..1
  conversationVelocity: number; // 0..1
  betCapitalFlow: number; // 0..1
}

export interface RetailAttentionIndex {
  value: number; // 0..100
  label: string;
  components: AttentionComponents;
}

const WEIGHTS: AttentionComponents = {
  stanceBalance: 0.35,
  breadth: 0.2,
  priceConfirmation: 0.2,
  conversationVelocity: 0.15,
  betCapitalFlow: 0.1,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function labelFor(value: number): string {
  if (value < 30) return "Subdued Retail Attention";
  if (value < 60) return "Moderate Retail Attention";
  if (value <= 80) return "Elevated Retail Attention";
  return "Extreme Retail Attention";
}

/** Blend components (0..1) into a 0..100 index with a descriptive label. */
export function computeRetailAttentionIndex(components: AttentionComponents): RetailAttentionIndex {
  const c: AttentionComponents = {
    stanceBalance: clamp01(components.stanceBalance),
    breadth: clamp01(components.breadth),
    priceConfirmation: clamp01(components.priceConfirmation),
    conversationVelocity: clamp01(components.conversationVelocity),
    betCapitalFlow: clamp01(components.betCapitalFlow),
  };

  const weighted =
    c.stanceBalance * WEIGHTS.stanceBalance +
    c.breadth * WEIGHTS.breadth +
    c.priceConfirmation * WEIGHTS.priceConfirmation +
    c.conversationVelocity * WEIGHTS.conversationVelocity +
    c.betCapitalFlow * WEIGHTS.betCapitalFlow;

  const value = Math.round(weighted * 100);
  return { value, label: labelFor(value), components: c };
}
