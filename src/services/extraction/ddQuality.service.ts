/**
 * ddQuality.service.ts
 *
 * Rule-based quality scorer for due-diligence ("DD") posts. Rewards concrete
 * numbers, cited sources, explicit calculations, named catalysts, honest risk
 * disclosure, and substantive original length. Produces six 0..1 sub-scores
 * and a 0..100 total with a coarse quality category. Fully deterministic.
 */

export interface DDQualityResult {
  score: number; // 0..100
  evidence_score: number; // 0..1
  source_score: number; // 0..1
  calculation_score: number; // 0..1
  catalyst_score: number; // 0..1
  risk_disclosure_score: number; // 0..1
  originality_score: number; // 0..1
  category: "low_quality" | "medium_quality" | "high_quality";
  explanation: string;
}

function countMatches(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m ? m.length : 0;
}

function ratioScore(count: number, saturateAt: number): number {
  if (saturateAt <= 0) return 0;
  return Math.max(0, Math.min(1, count / saturateAt));
}

/** Score DD text quality across six rule-based dimensions. */
export function scoreDDQuality(text: string): DDQualityResult {
  const lower = (text || "").toLowerCase();

  const numbers = countMatches(text, /\b\d+(\.\d+)?%?\b/g);
  const evidence_score = ratioScore(numbers, 12);

  const sources = countMatches(lower, /https?:\/\/|source[:s]?|10-k|10-q|sec filing|according to/g);
  const source_score = ratioScore(sources, 3);

  const calcs = countMatches(lower, /\bdcf\b|valuation|multiple|p\/e|ev\/ebitda|discount|margin|npv/g);
  const calculation_score = ratioScore(calcs, 3);

  const catalysts = countMatches(lower, /earnings|guidance|fda|approval|catalyst|merger|acquisition|buyback/g);
  const catalyst_score = ratioScore(catalysts, 3);

  const risks = countMatches(lower, /\brisk\b|downside|could lose|bear case|worst case|not financial advice/g);
  const risk_disclosure_score = ratioScore(risks, 3);

  const words = lower.split(/\s+/).filter(Boolean).length;
  const originality_score = ratioScore(words, 400);

  const total =
    evidence_score * 20 +
    source_score * 20 +
    calculation_score * 20 +
    catalyst_score * 15 +
    risk_disclosure_score * 15 +
    originality_score * 10;

  const score = Math.round(total);
  const category: DDQualityResult["category"] =
    score >= 70 ? "high_quality" : score >= 40 ? "medium_quality" : "low_quality";

  const explanation =
    `DD quality ${score}/100 (${category}): evidence ${evidence_score.toFixed(2)}, ` +
    `sources ${source_score.toFixed(2)}, calculations ${calculation_score.toFixed(2)}, ` +
    `catalysts ${catalyst_score.toFixed(2)}, risk disclosure ${risk_disclosure_score.toFixed(2)}, ` +
    `originality ${originality_score.toFixed(2)}.`;

  return {
    score,
    evidence_score: Math.round(evidence_score * 1000) / 1000,
    source_score: Math.round(source_score * 1000) / 1000,
    calculation_score: Math.round(calculation_score * 1000) / 1000,
    catalyst_score: Math.round(catalyst_score * 1000) / 1000,
    risk_disclosure_score: Math.round(risk_disclosure_score * 1000) / 1000,
    originality_score: Math.round(originality_score * 1000) / 1000,
    category,
    explanation,
  };
}
