/**
 * alertEngine.service.ts
 *
 * Deterministic, rule-based alert generation. Reads seeded positioning, pump,
 * and collective-P/L signals and emits evidence-based alert candidates. Each
 * alert carries a human explanation and an evidence object.
 */
import { metricsRepository } from "../../repositories/metrics.repository.js";
import { betsRepository } from "../../repositories/bets.repository.js";
import { alertsRepository } from "../../repositories/alerts.repository.js";

export type AlertType =
  | "declared_call_capital_spike"
  | "declared_put_capital_spike"
  | "verified_bets_cluster"
  | "smart_authors_against_crowd"
  | "conversation_up_capital_down"
  | "strike_concentration"
  | "high_iv_chasing"
  | "expiration_wall_this_week"
  | "possible_coordination"
  | "profitable_authors_early"
  | "bullish_sentiment_negative_collective_pl";

export interface AlertCandidate {
  ticker: string;
  alert_type: AlertType;
  severity: "low" | "medium" | "high";
  explanation: string;
  evidence: Record<string, unknown>;
}

/** Compute (but do not persist) alert candidates from current signals. */
export async function computeAlertCandidates(): Promise<AlertCandidate[]> {
  const [positioning, pumps, collective] = await Promise.all([
    metricsRepository.positioningLatest(),
    metricsRepository.pumpLatest(),
    betsRepository.collectivePl(),
  ]);

  const candidates: AlertCandidate[] = [];

  for (const p of positioning) {
    const ticker = p.ticker ?? "";
    const declaredCall = Number(p.declared_yolo_capital ?? 0);
    const callConviction = Number(p.call_conviction ?? 0);
    const putConviction = Number(p.put_conviction ?? 0);

    if (callConviction >= 0.7 && declaredCall >= 15000) {
      candidates.push({
        ticker,
        alert_type: "declared_call_capital_spike",
        severity: declaredCall >= 20000 ? "high" : "medium",
        explanation: `Declared call premium at risk is elevated (${fmt(declaredCall)}) with strong call conviction.`,
        evidence: { declared_call_capital: declaredCall, call_conviction: callConviction },
      });
    }
    if (putConviction >= 0.6) {
      candidates.push({
        ticker,
        alert_type: "declared_put_capital_spike",
        severity: "medium",
        explanation: `Put conviction is building (${putConviction}) against the crowd.`,
        evidence: { put_conviction: putConviction, declared_capital: Number(p.premium_at_risk ?? 0) },
      });
    }
  }

  for (const pump of pumps) {
    const score = Number(pump.score ?? 0);
    if (score >= 70) {
      candidates.push({
        ticker: pump.ticker ?? "",
        alert_type: "possible_coordination",
        severity: "high",
        explanation: pump.explanation ?? "Possible coordinated promotion detected.",
        evidence: {
          score,
          repeated_phrases: pump.repeated_phrases,
          author_concentration: pump.author_concentration,
          new_account_ratio: pump.new_account_ratio,
          deletion_rate: pump.deletion_rate,
        },
      });
    }
  }

  for (const c of collective) {
    const avgReturn = Number(c.avg_return_pct ?? 0);
    if (avgReturn < -20) {
      candidates.push({
        ticker: c.ticker ?? "",
        alert_type: "bullish_sentiment_negative_collective_pl",
        severity: "medium",
        explanation: `Collective P/L is deeply negative (${avgReturn}%) despite continued attention.`,
        evidence: { avg_return_pct: avgReturn, bets: c.bets },
      });
    }
  }

  return candidates;
}

/** Compute candidates and persist them to ticker_alerts. Returns inserted rows. */
export async function generateAndPersistAlerts(): Promise<unknown[]> {
  const candidates = await computeAlertCandidates();
  const inserted: unknown[] = [];
  for (const c of candidates) {
    const rows = await alertsRepository.insert({
      ticker: c.ticker,
      alert_type: c.alert_type,
      severity: c.severity,
      explanation: c.explanation,
      evidence: c.evidence,
    });
    inserted.push(...rows);
  }
  return inserted;
}

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}
