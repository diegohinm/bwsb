/**
 * optionsDataAdapter.service.ts
 *
 * Stub options-chain adapter backed by seeded option_contract_snapshots.
 * Interface is ready for a real options-chain provider.
 */
import { marketRepository } from "../../repositories/market.repository.js";

export interface OptionQuote {
  ticker: string;
  option_type: "call" | "put" | null;
  strike: number | null;
  expiration_date: string | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  implied_volatility: number | null;
  delta: number | null;
  open_interest: number | null;
  volume: number | null;
}

export interface OptionsDataAdapter {
  /** Contracts for an underlying symbol (canonical name for options records). */
  getChain(underlying: string): Promise<OptionQuote[]>;
  readonly provider: string;
}

export const optionsDataAdapter: OptionsDataAdapter = {
  provider: "stub",
  async getChain(underlying: string) {
    const rows = await marketRepository.optionContracts(underlying.toUpperCase());

    // The stored column is `underlying` (the canonical options naming); this
    // interface calls the same thing `ticker`, so the two are mapped explicitly
    // rather than cast — a blind cast left `ticker` undefined on every quote.
    return rows.map((r) => ({
      ticker: r.underlying,
      option_type: r.option_type,
      strike: r.strike,
      expiration_date: r.expiration_date
        ? r.expiration_date.toISOString().slice(0, 10)
        : null,
      bid: r.bid,
      ask: r.ask,
      mid: r.mid,
      implied_volatility: r.implied_volatility,
      delta: r.delta,
      open_interest: r.open_interest,
      volume: r.volume,
    }));
  },
};

/**
 * Baseline "fair value" of an option at publication time. Deterministic
 * placeholder (intrinsic + simple time value) until a pricing model is wired.
 */
export function estimateFairValue(params: {
  optionType: "call" | "put";
  strike: number;
  underlying: number;
  dte: number;
  impliedVolatility?: number;
}): number {
  const { optionType, strike, underlying, dte } = params;
  const iv = params.impliedVolatility ?? 0.6;
  const intrinsic =
    optionType === "call"
      ? Math.max(0, underlying - strike)
      : Math.max(0, strike - underlying);
  const timeValue = underlying * iv * Math.sqrt(Math.max(dte, 0) / 365) * 0.4;
  return Math.round((intrinsic + timeValue) * 100) / 100;
}
