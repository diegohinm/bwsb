import { query } from "../lib/db.js";
import type { TickerAlert } from "../types/domain.js";

export const alertsRepository = {
  list(limit = 50): Promise<TickerAlert[]> {
    return query<TickerAlert>(
      `SELECT id, ticker, alert_type, severity, explanation, metrics_snapshot, evidence, created_at
       FROM public.ticker_alerts ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
  },

  forTicker(ticker: string): Promise<TickerAlert[]> {
    return query<TickerAlert>(
      `SELECT id, ticker, alert_type, severity, explanation, metrics_snapshot, evidence, created_at
       FROM public.ticker_alerts WHERE ticker = $1 ORDER BY created_at DESC`,
      [ticker],
    );
  },

  insert(alert: {
    ticker: string;
    alert_type: string;
    severity: string;
    explanation: string;
    evidence: unknown;
  }): Promise<TickerAlert[]> {
    return query<TickerAlert>(
      `INSERT INTO public.ticker_alerts (ticker, alert_type, severity, explanation, evidence, metrics_snapshot)
       VALUES ($1,$2,$3,$4,$5::jsonb,'{"seed":false}'::jsonb)
       RETURNING id, ticker, alert_type, severity, explanation, metrics_snapshot, evidence, created_at`,
      [alert.ticker, alert.alert_type, alert.severity, alert.explanation, JSON.stringify(alert.evidence)],
    );
  },

  // ── User alert rules ──────────────────────────────────────────────────────
  listRules(userId: string) {
    return query(
      `SELECT * FROM public.user_alert_rules WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
  },

  insertRule(rule: {
    user_id: string;
    name: string;
    rule_type: string;
    ticker: string | null;
    params: unknown;
  }) {
    return query(
      `INSERT INTO public.user_alert_rules (user_id, name, rule_type, ticker, params)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
      [rule.user_id, rule.name, rule.rule_type, rule.ticker, JSON.stringify(rule.params)],
    );
  },
};
