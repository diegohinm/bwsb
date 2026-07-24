import { env } from "../../../config/env.js";

/**
 * Internal Databento defaults.
 *
 * INTENTIONALLY MINIMAL ENV SURFACE. Only three Databento env vars exist:
 *   DATABENTO_API_KEY            — backend-only credential (never sent to client)
 *   DATABENTO_DATASET            — equities dataset id      (default EQUS.MINI)
 *   DATABENTO_OVERNIGHT_DATASET  — overnight dataset id      (default OCEA.MEMOIR)
 *
 * Everything else below is fixed in code so the .env stays tiny. Retune Databento
 * by editing THESE constants, not by adding environment variables. The public
 * real-time / options-real-time / overnight toggles stay OFF: data is presented
 * as delayed / EOD / demo, never claimed as real-time.
 */
export const DATABENTO_CONFIG = {
  // Historical (REST) base, including the API version segment.
  baseUrl: "https://hist.databento.com/v0",

  // Basic equities market data.
  equitiesDataset: env.DATABENTO_DATASET ?? "EQUS.MINI",
  equitiesSchema: "ohlcv-1m",

  // Overnight market data (Databento overnight dataset).
  overnightDataset: env.DATABENTO_OVERNIGHT_DATASET ?? "OCEA.MEMOIR",
  overnightSchema: "ohlcv-1m",

  // Options (kept internal — no options env vars).
  optionsDataset: "OPRA.PILLAR",
  optionsSchema: "definition",

  // Symbology used for historical timeseries requests.
  stypeIn: "raw_symbol",
  stypeOut: "instrument_id",

  // Safety toggles — all OFF by default. Nothing is ever labeled real-time and
  // no live stream is opened unless these are deliberately flipped in code.
  liveEnabled: false,
  publicRealtimeEnabled: false,
  publicOptionsRealtimeEnabled: false,
  publicOvernightEnabled: false,
} as const;
