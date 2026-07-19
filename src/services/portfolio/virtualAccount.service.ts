/**
 * virtualAccount.service.ts
 *
 * Paper-trading engine. Virtual money only — no real funds. Every user gets a
 * $100,000 virtual account on first access. Trades adjust cash and positions;
 * equity is marked to the latest seeded market snapshot.
 */
import {
  virtualRepository,
  type VirtualAccount,
  type VirtualPosition,
} from "../../repositories/virtual.repository.js";
import { marketRepository } from "../../repositories/market.repository.js";

const DEFAULT_STARTING_CASH = 100000;

export type TradeSide = "buy" | "sell" | "short" | "cover";
export type TradeInstrument = "stock" | "option";

export interface TradeInput {
  ticker: string;
  side: TradeSide;
  instrument: TradeInstrument;
  option_type?: "call" | "put" | null;
  strike?: number | null;
  expiration_date?: string | null;
  quantity: number;
  price: number;
}

/** Get or create the user's virtual account. */
export async function ensureAccount(userId: string): Promise<VirtualAccount> {
  const existing = await virtualRepository.accountForUser(userId);
  if (existing) return existing;
  const created = await virtualRepository.createAccount(userId, DEFAULT_STARTING_CASH);
  return created!;
}

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));
const round = (n: number) => Math.round(n * 100) / 100;

/** Mark a position to market and return its value + unrealized P/L. */
async function valuePosition(pos: VirtualPosition): Promise<{ marketValue: number; unrealizedPl: number }> {
  const qty = num(pos.quantity);
  const avg = num(pos.avg_cost);
  if (pos.instrument === "stock") {
    const snap = await marketRepository.latestSnapshot(pos.ticker);
    const price = snap ? num(snap.price) : avg;
    return { marketValue: round(price * qty), unrealizedPl: round((price - avg) * qty) };
  }
  // Options: no live chain price wired — value at cost (100 shares/contract).
  return { marketValue: round(avg * qty * 100), unrealizedPl: 0 };
}

/** Recompute and persist account equity from cash + marked positions. */
async function revalue(account: VirtualAccount): Promise<{ account: VirtualAccount; positions: VirtualPosition[] }> {
  const positions = await virtualRepository.listPositions(account.id);
  let positionsValue = 0;
  const valued: VirtualPosition[] = [];
  for (const pos of positions) {
    const { marketValue, unrealizedPl } = await valuePosition(pos);
    await virtualRepository.setPositionValuation(pos.id, marketValue, unrealizedPl);
    positionsValue += marketValue;
    valued.push({ ...pos, market_value: marketValue, unrealized_pl: unrealizedPl });
  }
  const cash = num(account.cash_balance);
  const updated = await virtualRepository.updateBalances(account.id, round(cash), round(cash + positionsValue));
  return { account: updated ?? account, positions: valued };
}

/** Full portfolio snapshot for the portfolio page. */
export async function getPortfolio(userId: string) {
  const account = await ensureAccount(userId);
  const { account: revalued, positions } = await revalue(account);
  const trades = await virtualRepository.listTrades(account.id, 100);
  return {
    account: revalued,
    positions,
    trades,
    note: "Virtual trading only. No real money.",
  };
}

/** Execute a paper trade: adjust cash, upsert the position, record the trade. */
export async function placeTrade(userId: string, input: TradeInput) {
  const account = await ensureAccount(userId);
  const qty = Math.abs(Number(input.quantity));
  const price = Number(input.price);
  if (!input.ticker || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid trade: ticker, positive quantity and positive price are required");
  }

  const multiplier = input.instrument === "option" ? 100 : 1;
  const notional = round(qty * price * multiplier);
  const fees = 0;

  // Cash: buys/covers spend cash; sells/shorts add proceeds.
  const spendsCash = input.side === "buy" || input.side === "cover";
  const cashDelta = spendsCash ? -(notional + fees) : notional - fees;
  const newCash = round(num(account.cash_balance) + cashDelta);

  // Position delta: buy/cover increase; sell/short decrease.
  const delta = spendsCash ? qty : -qty;
  const key = {
    ticker: input.ticker.toUpperCase(),
    instrument: input.instrument,
    option_type: input.option_type ?? null,
    strike: input.strike ?? null,
    expiration_date: input.expiration_date ?? null,
  };
  const existing = await virtualRepository.findPosition(account.id, key);

  if (!existing) {
    if (delta !== 0) {
      await virtualRepository.insertPosition({
        user_id: userId,
        virtual_account_id: account.id,
        ...key,
        quantity: delta,
        avg_cost: price,
      });
    }
  } else {
    const oldQty = num(existing.quantity);
    const oldAvg = num(existing.avg_cost);
    const newQty = oldQty + delta;
    if (Math.abs(newQty) < 1e-9) {
      await virtualRepository.deletePosition(existing.id);
    } else {
      const increasing = Math.sign(newQty) === Math.sign(oldQty) && Math.abs(newQty) > Math.abs(oldQty);
      const flipped = oldQty !== 0 && Math.sign(newQty) !== Math.sign(oldQty);
      const newAvg = increasing
        ? round((Math.abs(oldQty) * oldAvg + qty * price) / Math.abs(newQty))
        : flipped
          ? price
          : oldAvg;
      await virtualRepository.updatePosition(existing.id, newQty, newAvg, 0, 0);
    }
  }

  // Persist the cash change, record the trade, then revalue equity.
  await virtualRepository.updateBalances(account.id, newCash, num(account.equity_value));
  const trade = await virtualRepository.insertTrade({
    user_id: userId,
    virtual_account_id: account.id,
    ticker: key.ticker,
    side: input.side,
    instrument: input.instrument,
    option_type: key.option_type,
    strike: key.strike,
    expiration_date: key.expiration_date,
    quantity: qty,
    price,
    notional_value: notional,
    fees,
  });

  const refreshed = (await virtualRepository.accountForUser(userId))!;
  const { account: revalued, positions } = await revalue(refreshed);
  return { trade, account: revalued, positions };
}
