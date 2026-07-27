import { Prisma } from "@prisma/client";
import type {
  VirtualAccounts,
  VirtualPositions,
  VirtualTrades,
} from "@prisma/client";

import { prisma } from "../lib/prisma.js";

/**
 * Data access for virtual (paper) trading accounts, trades and positions.
 *
 * Reads and writes go through Prisma, but every row is mapped back to the
 * snake_case shape the API already returns. These rows are serialized straight
 * onto the wire by /api/account, /api/portfolio and /api/portfolio/virtual-trades,
 * and the frontend (fwsb/src/api/personalApi.ts) reads those exact keys —
 * renaming them here would break it.
 *
 * `numeric` columns stay strings, as the pg driver returned them, so money keeps
 * full precision instead of being rounded through a JS float.
 */

/** numeric → string (pg's representation); null stays null. */
function dec(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/** numeric NOT NULL → string. */
function decRequired(value: Prisma.Decimal): string {
  return value.toString();
}

export interface VirtualAccount {
  id: string;
  user_id: string;
  starting_cash: number | string;
  cash_balance: number | string;
  equity_value: number | string;
  currency: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VirtualPosition {
  id: string;
  user_id: string;
  virtual_account_id: string | null;
  ticker: string | null;
  instrument: string | null;
  option_type: string | null;
  strike: number | string | null;
  expiration_date: Date | null;
  quantity: number | string;
  avg_cost: number | string;
  market_value: number | string | null;
  unrealized_pl: number | string | null;
  updated_at: Date;
}

export interface VirtualTrade {
  id: string;
  user_id: string;
  virtual_account_id: string | null;
  ticker: string | null;
  side: string | null;
  instrument: string | null;
  option_type: string | null;
  strike: number | string | null;
  expiration_date: Date | null;
  quantity: number | string;
  price: number | string;
  notional_value: number | string;
  fees: number | string | null;
  status: string | null;
  created_at: Date;
}

function toAccount(r: VirtualAccounts): VirtualAccount {
  return {
    id: r.id,
    user_id: r.userId,
    starting_cash: decRequired(r.startingCash),
    cash_balance: decRequired(r.cashBalance),
    equity_value: decRequired(r.equityValue),
    currency: r.currency,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function toPosition(r: VirtualPositions): VirtualPosition {
  return {
    id: r.id,
    user_id: r.userId,
    virtual_account_id: r.virtualAccountId,
    ticker: r.ticker,
    instrument: r.instrument,
    option_type: r.optionType,
    strike: dec(r.strike),
    expiration_date: r.expirationDate,
    quantity: decRequired(r.quantity),
    avg_cost: decRequired(r.avgCost),
    market_value: dec(r.marketValue),
    unrealized_pl: dec(r.unrealizedPl),
    updated_at: r.updatedAt,
  };
}

function toTrade(r: VirtualTrades): VirtualTrade {
  return {
    id: r.id,
    user_id: r.userId,
    virtual_account_id: r.virtualAccountId,
    ticker: r.ticker,
    side: r.side,
    instrument: r.instrument,
    option_type: r.optionType,
    strike: dec(r.strike),
    expiration_date: r.expirationDate,
    quantity: decRequired(r.quantity),
    price: decRequired(r.price),
    notional_value: decRequired(r.notionalValue),
    fees: dec(r.fees),
    status: r.status,
    created_at: r.createdAt,
  };
}

/**
 * A `date` column takes a date-only string ("2026-01-16"), which is not valid
 * ISO-8601 for Prisma. Anchor it at UTC midnight so the stored day is the day
 * the caller meant, whatever the server's timezone.
 */
function toDateOnly(value: string | null): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Run an update that may target a row that no longer exists; null if gone. */
async function updateOrNull<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return null;
    }
    throw err;
  }
}

export const virtualRepository = {
  async accountForUser(userId: string): Promise<VirtualAccount | null> {
    const row = await prisma.virtualAccounts.findUnique({ where: { userId } });
    return row ? toAccount(row) : null;
  },

  /** Idempotently create the paper-trading account with the default cash. */
  async createAccount(
    userId: string,
    startingCash = 100000,
  ): Promise<VirtualAccount | null> {
    const row = await prisma.virtualAccounts.upsert({
      where: { userId },
      create: {
        userId,
        startingCash,
        cashBalance: startingCash,
        equityValue: startingCash,
      },
      // Already had an account: touch it, never reset the balances.
      update: { updatedAt: new Date() },
    });
    return toAccount(row);
  },

  async updateBalances(
    accountId: string,
    cashBalance: number,
    equityValue: number,
  ): Promise<VirtualAccount | null> {
    const row = await updateOrNull(() =>
      prisma.virtualAccounts.update({
        where: { id: accountId },
        data: { cashBalance, equityValue, updatedAt: new Date() },
      }),
    );
    return row ? toAccount(row) : null;
  },

  async insertTrade(trade: {
    user_id: string;
    virtual_account_id: string;
    ticker: string;
    side: string;
    instrument: string;
    option_type: string | null;
    strike: number | null;
    expiration_date: string | null;
    quantity: number;
    price: number;
    notional_value: number;
    fees: number;
  }): Promise<VirtualTrade> {
    const row = await prisma.virtualTrades.create({
      data: {
        userId: trade.user_id,
        virtualAccountId: trade.virtual_account_id,
        ticker: trade.ticker,
        side: trade.side,
        instrument: trade.instrument,
        optionType: trade.option_type,
        strike: trade.strike,
        expirationDate: toDateOnly(trade.expiration_date),
        quantity: trade.quantity,
        price: trade.price,
        notionalValue: trade.notional_value,
        fees: trade.fees,
      },
    });
    return toTrade(row);
  },

  async listTrades(accountId: string, limit = 100): Promise<VirtualTrade[]> {
    const rows = await prisma.virtualTrades.findMany({
      where: { virtualAccountId: accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toTrade);
  },

  async listPositions(accountId: string): Promise<VirtualPosition[]> {
    const rows = await prisma.virtualPositions.findMany({
      where: { virtualAccountId: accountId },
      orderBy: { ticker: "asc" },
    });
    return rows.map(toPosition);
  },

  /**
   * Find a matching open position. Prisma compiles `field: null` to `IS NULL`,
   * which is the NULL-safe match the option columns need — a stock position has
   * no option_type/strike/expiration and must still be found.
   */
  async findPosition(
    accountId: string,
    key: {
      ticker: string;
      instrument: string;
      option_type: string | null;
      strike: number | null;
      expiration_date: string | null;
    },
  ): Promise<VirtualPosition | null> {
    const row = await prisma.virtualPositions.findFirst({
      where: {
        virtualAccountId: accountId,
        ticker: key.ticker,
        instrument: key.instrument,
        optionType: key.option_type,
        strike: key.strike,
        expirationDate: toDateOnly(key.expiration_date),
      },
    });
    return row ? toPosition(row) : null;
  },

  async insertPosition(pos: {
    user_id: string;
    virtual_account_id: string;
    ticker: string;
    instrument: string;
    option_type: string | null;
    strike: number | null;
    expiration_date: string | null;
    quantity: number;
    avg_cost: number;
  }): Promise<VirtualPosition> {
    const row = await prisma.virtualPositions.create({
      data: {
        userId: pos.user_id,
        virtualAccountId: pos.virtual_account_id,
        ticker: pos.ticker,
        instrument: pos.instrument,
        optionType: pos.option_type,
        strike: pos.strike,
        expirationDate: toDateOnly(pos.expiration_date),
        quantity: pos.quantity,
        avgCost: pos.avg_cost,
      },
    });
    return toPosition(row);
  },

  async updatePosition(
    id: string,
    quantity: number,
    avgCost: number,
    marketValue: number,
    unrealizedPl: number,
  ): Promise<VirtualPosition | null> {
    const row = await updateOrNull(() =>
      prisma.virtualPositions.update({
        where: { id },
        data: {
          quantity,
          avgCost,
          marketValue,
          unrealizedPl,
          updatedAt: new Date(),
        },
      }),
    );
    return row ? toPosition(row) : null;
  },

  async deletePosition(id: string): Promise<void> {
    await prisma.virtualPositions.deleteMany({ where: { id } });
  },

  async setPositionValuation(
    id: string,
    marketValue: number,
    unrealizedPl: number,
  ): Promise<void> {
    // updateMany, not update: the revaluation loop must not throw when a
    // position was closed by a concurrent trade.
    await prisma.virtualPositions.updateMany({
      where: { id },
      data: { marketValue, unrealizedPl, updatedAt: new Date() },
    });
  },
};
