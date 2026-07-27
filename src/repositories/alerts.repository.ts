import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { toDbRow, toDbRows } from "../lib/rows.js";
import type { TickerAlert } from "../types/domain.js";

/**
 * Data access for generated ticker alerts and user alert rules.
 *
 * Rows are returned with their database column names (see lib/rows.ts) because
 * the alerts routes serialize them straight onto the wire.
 */

/** Columns the alerts endpoints expose. */
const ALERT_COLUMNS = {
  id: true,
  ticker: true,
  alertType: true,
  severity: true,
  explanation: true,
  metricsSnapshot: true,
  evidence: true,
  createdAt: true,
} as const;

export const alertsRepository = {
  async list(limit = 50): Promise<TickerAlert[]> {
    const rows = await prisma.tickerAlerts.findMany({
      select: ALERT_COLUMNS,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return toDbRows<TickerAlert>("TickerAlerts", rows);
  },

  async forTicker(ticker: string): Promise<TickerAlert[]> {
    const rows = await prisma.tickerAlerts.findMany({
      where: { ticker },
      select: ALERT_COLUMNS,
      orderBy: { createdAt: "desc" },
    });
    return toDbRows<TickerAlert>("TickerAlerts", rows);
  },

  /** Returns a 1-element list, mirroring the old INSERT … RETURNING. */
  async insert(alert: {
    ticker: string;
    alert_type: string;
    severity: string;
    explanation: string;
    evidence: unknown;
  }): Promise<TickerAlert[]> {
    const row = await prisma.tickerAlerts.create({
      data: {
        ticker: alert.ticker,
        alertType: alert.alert_type,
        severity: alert.severity,
        explanation: alert.explanation,
        evidence: (alert.evidence ?? {}) as Prisma.InputJsonValue,
        // Marks the row as engine-generated rather than seeded demo data.
        metricsSnapshot: { seed: false },
      },
      select: ALERT_COLUMNS,
    });
    return [toDbRow<TickerAlert>("TickerAlerts", row)];
  },

  // ── User alert rules ──────────────────────────────────────────────────────
  async listRules(userId: string) {
    const rows = await prisma.userAlertRules.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return toDbRows("UserAlertRules", rows);
  },

  /** Returns a 1-element list, mirroring the old INSERT … RETURNING. */
  async insertRule(rule: {
    user_id: string;
    name: string;
    rule_type: string;
    ticker: string | null;
    params: unknown;
  }) {
    const row = await prisma.userAlertRules.create({
      data: {
        userId: rule.user_id,
        name: rule.name,
        ruleType: rule.rule_type,
        ticker: rule.ticker,
        params: (rule.params ?? {}) as Prisma.InputJsonValue,
      },
    });
    return [toDbRow("UserAlertRules", row)];
  },
};
