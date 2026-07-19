import { query, queryOne } from "../lib/db.js";

export interface VirtualAccount {
  id: string;
  user_id: string;
  starting_cash: number | string;
  cash_balance: number | string;
  equity_value: number | string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface VirtualPosition {
  id: string;
  virtual_account_id: string;
  ticker: string;
  instrument: string;
  option_type: string | null;
  strike: number | string | null;
  expiration_date: string | null;
  quantity: number | string;
  avg_cost: number | string;
  market_value: number | string;
  unrealized_pl: number | string;
}

/** Data access for virtual (paper) trading accounts, trades and positions. */
export const virtualRepository = {
  accountForUser(userId: string): Promise<VirtualAccount | null> {
    return queryOne<VirtualAccount>(
      `SELECT * FROM public.virtual_accounts WHERE user_id = $1`,
      [userId],
    );
  },

  /** Idempotently create the paper-trading account with the default cash. */
  createAccount(userId: string, startingCash = 100000): Promise<VirtualAccount | null> {
    return queryOne<VirtualAccount>(
      `INSERT INTO public.virtual_accounts (user_id, starting_cash, cash_balance, equity_value)
       VALUES ($1, $2, $2, $2)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [userId, startingCash],
    );
  },

  updateBalances(accountId: string, cashBalance: number, equityValue: number) {
    return queryOne<VirtualAccount>(
      `UPDATE public.virtual_accounts
       SET cash_balance = $2, equity_value = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [accountId, cashBalance, equityValue],
    );
  },

  insertTrade(trade: {
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
  }) {
    return queryOne(
      `INSERT INTO public.virtual_trades
         (user_id, virtual_account_id, ticker, side, instrument, option_type, strike,
          expiration_date, quantity, price, notional_value, fees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        trade.user_id, trade.virtual_account_id, trade.ticker, trade.side,
        trade.instrument, trade.option_type, trade.strike, trade.expiration_date,
        trade.quantity, trade.price, trade.notional_value, trade.fees,
      ],
    );
  },

  listTrades(accountId: string, limit = 100) {
    return query(
      `SELECT * FROM public.virtual_trades WHERE virtual_account_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [accountId, limit],
    );
  },

  listPositions(accountId: string): Promise<VirtualPosition[]> {
    return query<VirtualPosition>(
      `SELECT * FROM public.virtual_positions WHERE virtual_account_id = $1
       ORDER BY ticker ASC`,
      [accountId],
    );
  },

  /** Find a matching open position (NULL-safe on option fields). */
  findPosition(accountId: string, key: {
    ticker: string;
    instrument: string;
    option_type: string | null;
    strike: number | null;
    expiration_date: string | null;
  }): Promise<VirtualPosition | null> {
    return queryOne<VirtualPosition>(
      `SELECT * FROM public.virtual_positions
       WHERE virtual_account_id = $1 AND ticker = $2 AND instrument = $3
         AND option_type IS NOT DISTINCT FROM $4
         AND strike IS NOT DISTINCT FROM $5
         AND expiration_date IS NOT DISTINCT FROM $6`,
      [accountId, key.ticker, key.instrument, key.option_type, key.strike, key.expiration_date],
    );
  },

  insertPosition(pos: {
    user_id: string;
    virtual_account_id: string;
    ticker: string;
    instrument: string;
    option_type: string | null;
    strike: number | null;
    expiration_date: string | null;
    quantity: number;
    avg_cost: number;
  }) {
    return queryOne(
      `INSERT INTO public.virtual_positions
         (user_id, virtual_account_id, ticker, instrument, option_type, strike,
          expiration_date, quantity, avg_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        pos.user_id, pos.virtual_account_id, pos.ticker, pos.instrument,
        pos.option_type, pos.strike, pos.expiration_date, pos.quantity, pos.avg_cost,
      ],
    );
  },

  updatePosition(id: string, quantity: number, avgCost: number, marketValue: number, unrealizedPl: number) {
    return queryOne(
      `UPDATE public.virtual_positions
       SET quantity = $2, avg_cost = $3, market_value = $4, unrealized_pl = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, quantity, avgCost, marketValue, unrealizedPl],
    );
  },

  deletePosition(id: string) {
    return query(`DELETE FROM public.virtual_positions WHERE id = $1`, [id]);
  },

  setPositionValuation(id: string, marketValue: number, unrealizedPl: number) {
    return query(
      `UPDATE public.virtual_positions SET market_value = $2, unrealized_pl = $3, updated_at = now()
       WHERE id = $1`,
      [id, marketValue, unrealizedPl],
    );
  },
};
