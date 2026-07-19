/**
 * positioningIndex.service.ts
 *
 * Aggregates a set of extracted option/stock bets into a positioning index:
 * call vs put conviction, declared/verified capital at risk, average DTE,
 * premium at risk, a leveraged sentiment tilt, and an expiration wall by DTE
 * bucket. Pure, deterministic aggregation over plain bet rows.
 */

export interface PositioningBet {
  option_type: "call" | "put" | null;
  declared_capital: number | null;
  verified_capital: number | null;
  dte: number | null;
  premium: number | null;
  contracts: number | null;
}

export interface PositioningIndex {
  call_conviction: number; // 0..1 share of declared capital on calls
  put_conviction: number; // 0..1 share of declared capital on puts
  net_directional_conviction: number; // -1..1 (calls positive)
  declared_yolo_capital: number;
  verified_yolo_capital: number;
  average_dte: number;
  premium_at_risk: number;
  leveraged_sentiment: number; // premium-weighted directional tilt
  expiration_wall: Record<string, number>; // DTE bucket -> declared capital
}

function dteBucket(dte: number): string {
  if (dte <= 7) return "0-7d";
  if (dte <= 30) return "8-30d";
  if (dte <= 90) return "31-90d";
  return "90d+";
}

/** Aggregate bets into a deterministic positioning index. */
export function computePositioningIndex(bets: PositioningBet[]): PositioningIndex {
  let callCapital = 0;
  let putCapital = 0;
  let declaredTotal = 0;
  let verifiedTotal = 0;
  let dteSum = 0;
  let dteCount = 0;
  let premiumTotal = 0;
  let leveraged = 0;
  const expiration_wall: Record<string, number> = {};

  for (const b of bets) {
    const declared = Math.max(0, b.declared_capital ?? 0);
    const verified = Math.max(0, b.verified_capital ?? 0);
    const premium = Math.max(0, b.premium ?? 0);

    declaredTotal += declared;
    verifiedTotal += verified;
    premiumTotal += premium;

    if (b.option_type === "call") {
      callCapital += declared;
      leveraged += premium;
    } else if (b.option_type === "put") {
      putCapital += declared;
      leveraged -= premium;
    }

    if (b.dte !== null && b.dte >= 0) {
      dteSum += b.dte;
      dteCount += 1;
      const bucket = dteBucket(b.dte);
      expiration_wall[bucket] = (expiration_wall[bucket] ?? 0) + declared;
    }
  }

  const directionalCapital = callCapital + putCapital;
  const call_conviction = directionalCapital > 0 ? callCapital / directionalCapital : 0;
  const put_conviction = directionalCapital > 0 ? putCapital / directionalCapital : 0;

  return {
    call_conviction: Math.round(call_conviction * 1000) / 1000,
    put_conviction: Math.round(put_conviction * 1000) / 1000,
    net_directional_conviction: Math.round((call_conviction - put_conviction) * 1000) / 1000,
    declared_yolo_capital: Math.round(declaredTotal * 100) / 100,
    verified_yolo_capital: Math.round(verifiedTotal * 100) / 100,
    average_dte: dteCount > 0 ? Math.round((dteSum / dteCount) * 10) / 10 : 0,
    premium_at_risk: Math.round(premiumTotal * 100) / 100,
    leveraged_sentiment: premiumTotal > 0 ? Math.round((leveraged / premiumTotal) * 1000) / 1000 : 0,
    expiration_wall,
  };
}
