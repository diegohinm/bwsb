/**
 * A ticker row from the public.tickers table.
 */
export type Ticker = {
  ticker: string;
  company_name: string | null;
  exchange: string | null;
  is_active: boolean | null;
  is_common_word: boolean | null;
  created_at?: string | null;
};
