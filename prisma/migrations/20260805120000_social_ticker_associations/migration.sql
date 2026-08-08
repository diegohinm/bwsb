-- Normalized ticker associations for social content, plus the catalog data the
-- extractor validates against.
--
-- WHY A JOIN TABLE WHEN `social_posts.tickers text[]` ALREADY EXISTS
--
-- The array stays. Six surfaces query it through GIN indexes (`tickers @> ...`)
-- — the Discussion read path, Subreddit Pulse, ticker social metrics, the strip,
-- trending, Arena — and it answers "which rows mention X" in one index hit.
-- What it cannot carry is WHY a symbol is attached: how confident the match was,
-- whether it came from a cashtag or a company name, and what text produced it.
-- Those are exactly what decide whether a badge may be shown publicly.
--
-- So the array becomes a DENORMALIZED PROJECTION of this table — the display
-- set, containing only associations at or above the display threshold — and
-- this table is the record of what was actually found. Everything that writes
-- one writes the other in the same transaction.
--
-- The FK to `tickers` is the point, not a formality: a row cannot exist for a
-- symbol outside the catalog, so no amount of clever extraction can invent
-- "DRAM" or "SPCX" as a security. Validation is enforced by the database, not
-- only by the code that happens to run before it.

CREATE TABLE IF NOT EXISTS "social_post_tickers" (
    "social_post_id" UUID    NOT NULL,
    "ticker"         TEXT    NOT NULL,
    -- 0..1. The extractor's certainty; see tickerExtraction.service.ts for the
    -- ladder. Only rows at or above the display threshold reach the UI.
    "confidence"     DECIMAL(4, 3) NOT NULL,
    -- How it was found: 'cashtag' | 'symbol' | 'alias'. Kept so a later change
    -- to the ladder can be evaluated against real data instead of guessed at.
    "source"         TEXT    NOT NULL,
    -- The literal substring that matched, for auditing false positives.
    "matched_text"   TEXT,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "social_post_tickers_pkey" PRIMARY KEY ("social_post_id", "ticker"),
    CONSTRAINT "social_post_tickers_post_fkey" FOREIGN KEY ("social_post_id")
        REFERENCES "social_posts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_post_tickers_ticker_fkey" FOREIGN KEY ("ticker")
        REFERENCES "tickers" ("ticker") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "social_post_tickers_ticker_idx"
    ON "social_post_tickers" ("ticker");
CREATE INDEX IF NOT EXISTS "social_post_tickers_confidence_idx"
    ON "social_post_tickers" ("ticker", "confidence" DESC);

CREATE TABLE IF NOT EXISTS "social_comment_tickers" (
    "social_comment_id" UUID    NOT NULL,
    "ticker"            TEXT    NOT NULL,
    "confidence"        DECIMAL(4, 3) NOT NULL,
    "source"            TEXT    NOT NULL,
    "matched_text"      TEXT,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "social_comment_tickers_pkey" PRIMARY KEY ("social_comment_id", "ticker"),
    CONSTRAINT "social_comment_tickers_comment_fkey" FOREIGN KEY ("social_comment_id")
        REFERENCES "social_comments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "social_comment_tickers_ticker_fkey" FOREIGN KEY ("ticker")
        REFERENCES "tickers" ("ticker") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "social_comment_tickers_ticker_idx"
    ON "social_comment_tickers" ("ticker");

-- ---------------------------------------------------------------------------
-- Company names and aliases
-- ---------------------------------------------------------------------------
--
-- "Nvidia earnings look strong" has to reach NVDA, and "I ate an apple" must
-- not reach AAPL. One table, one flag: `requires_context` marks an alias that
-- is also an ordinary English word or a place, and those are only accepted when
-- the surrounding text is recognizably financial.

CREATE TABLE IF NOT EXISTS "ticker_aliases" (
    -- Lowercased at write time; matching is done on a lowercased haystack.
    "alias"            TEXT    NOT NULL,
    "ticker"           TEXT    NOT NULL,
    -- true  -> the word has a common non-financial meaning (apple, meta,
    --          amazon, block, now). Needs financial context to count.
    -- false -> effectively unambiguous in prose (nvidia, palantir, salesforce).
    "requires_context" BOOLEAN NOT NULL DEFAULT false,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ticker_aliases_pkey" PRIMARY KEY ("alias"),
    CONSTRAINT "ticker_aliases_ticker_fkey" FOREIGN KEY ("ticker")
        REFERENCES "tickers" ("ticker") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ticker_aliases_ticker_idx" ON "ticker_aliases" ("ticker");

-- ---------------------------------------------------------------------------
-- Catalog expansion
-- ---------------------------------------------------------------------------
--
-- The catalog held 27 symbols, which is why real mentions were being dropped:
-- AVGO appears in stored posts and was never validatable. This adds the large
-- caps and the names r/wallstreetbets actually talks about.
--
-- `is_common_word` is the deliberate part. A symbol carrying it is a real
-- security whose ticker is also an everyday word, so a bare uppercase mention
-- of it is NOT enough on its own — the extractor demands financial context.
-- That is what keeps "AI is changing everything" from becoming a C3.ai badge
-- while leaving "$AI" and "AI stock" working.

INSERT INTO "tickers" ("ticker", "company_name", "exchange", "is_active", "is_common_word") VALUES
    ('AVGO', 'Broadcom Inc.',                 'NASDAQ', true,  false),
    ('TSM',  'Taiwan Semiconductor',          'NYSE',   true,  false),
    ('MRVL', 'Marvell Technology',            'NASDAQ', true,  false),
    ('SMCI', 'Super Micro Computer',          'NASDAQ', true,  false),
    ('ARM',  'Arm Holdings plc',              'NASDAQ', true,  true),
    ('QCOM', 'QUALCOMM Inc.',                 'NASDAQ', true,  false),
    ('TXN',  'Texas Instruments',             'NASDAQ', true,  false),
    ('ASML', 'ASML Holding N.V.',             'NASDAQ', true,  false),
    ('WDC',  'Western Digital',               'NASDAQ', true,  false),
    ('STX',  'Seagate Technology',            'NASDAQ', true,  false),
    ('DELL', 'Dell Technologies',             'NYSE',   true,  false),
    ('ORCL', 'Oracle Corp.',                  'NYSE',   true,  false),
    ('IBM',  'International Business Machines','NYSE',  true,  false),
    ('CSCO', 'Cisco Systems',                 'NASDAQ', true,  false),
    ('ADBE', 'Adobe Inc.',                    'NASDAQ', true,  false),
    ('UBER', 'Uber Technologies',             'NYSE',   true,  false),
    ('LYFT', 'Lyft, Inc.',                    'NASDAQ', true,  false),
    ('ABNB', 'Airbnb, Inc.',                  'NASDAQ', true,  false),
    ('SHOP', 'Shopify Inc.',                  'NYSE',   true,  false),
    ('SQ',   'Block, Inc.',                   'NYSE',   true,  false),
    ('PYPL', 'PayPal Holdings',               'NASDAQ', true,  false),
    ('DIS',  'Walt Disney Co.',               'NYSE',   true,  false),
    ('BA',   'Boeing Co.',                    'NYSE',   true,  false),
    ('F',    'Ford Motor Co.',                'NYSE',   true,  true),
    ('GM',   'General Motors',                'NYSE',   true,  false),
    ('RIVN', 'Rivian Automotive',             'NASDAQ', true,  false),
    ('LCID', 'Lucid Group',                   'NASDAQ', true,  false),
    ('NIO',  'NIO Inc.',                      'NYSE',   true,  false),
    ('JPM',  'JPMorgan Chase',                'NYSE',   true,  false),
    ('BAC',  'Bank of America',               'NYSE',   true,  false),
    ('GS',   'Goldman Sachs',                 'NYSE',   true,  false),
    ('V',    'Visa Inc.',                     'NYSE',   true,  true),
    ('MA',   'Mastercard Inc.',               'NYSE',   true,  true),
    ('WMT',  'Walmart Inc.',                  'NYSE',   true,  false),
    ('COST', 'Costco Wholesale',              'NASDAQ', true,  true),
    ('TGT',  'Target Corp.',                  'NYSE',   true,  false),
    ('NKE',  'NIKE, Inc.',                    'NYSE',   true,  false),
    ('SBUX', 'Starbucks Corp.',               'NASDAQ', true,  false),
    ('MCD',  'McDonald''s Corp.',             'NYSE',   true,  false),
    ('KO',   'Coca-Cola Co.',                 'NYSE',   true,  false),
    ('PEP',  'PepsiCo, Inc.',                 'NASDAQ', true,  false),
    ('PFE',  'Pfizer Inc.',                   'NYSE',   true,  false),
    ('LLY',  'Eli Lilly and Co.',             'NYSE',   true,  false),
    ('UNH',  'UnitedHealth Group',            'NYSE',   true,  false),
    ('XOM',  'Exxon Mobil Corp.',             'NYSE',   true,  false),
    ('CVX',  'Chevron Corp.',                 'NYSE',   true,  false),
    ('T',    'AT&T Inc.',                     'NYSE',   true,  true),
    ('VZ',   'Verizon Communications',        'NYSE',   true,  false),
    ('MRNA', 'Moderna, Inc.',                 'NASDAQ', true,  false),
    ('BABA', 'Alibaba Group',                 'NYSE',   true,  false),
    ('SNAP', 'Snap Inc.',                     'NYSE',   true,  true),
    ('SPOT', 'Spotify Technology',            'NYSE',   true,  true),
    ('ROKU', 'Roku, Inc.',                    'NASDAQ', true,  false),
    ('CRWD', 'CrowdStrike Holdings',          'NASDAQ', true,  false),
    ('SNOW', 'Snowflake Inc.',                'NYSE',   true,  true),
    ('NET',  'Cloudflare, Inc.',              'NYSE',   true,  true),
    ('DDOG', 'Datadog, Inc.',                 'NASDAQ', true,  false),
    ('ZM',   'Zoom Communications',           'NASDAQ', true,  false),
    ('CMG',  'Chipotle Mexican Grill',        'NYSE',   true,  false),
    ('MSTR', 'MicroStrategy Inc.',            'NASDAQ', true,  false),
    ('IWM',  'iShares Russell 2000 ETF',      'NYSEARCA', true, false),
    ('DIA',  'SPDR Dow Jones ETF',            'NYSEARCA', true, false),
    ('VTI',  'Vanguard Total Stock Market',   'NYSEARCA', true, false),
    ('VOO',  'Vanguard S&P 500 ETF',          'NYSEARCA', true, false),
    ('TQQQ', 'ProShares UltraPro QQQ',        'NASDAQ', true,  false),
    ('SQQQ', 'ProShares UltraPro Short QQQ',  'NASDAQ', true,  false),
    ('BBBY', 'Bed Bath & Beyond',             'NASDAQ', false, false),
    ('MARA', 'MARA Holdings',                 'NASDAQ', true,  false),
    ('RIOT', 'Riot Platforms',                'NASDAQ', true,  false),
    ('CLSK', 'CleanSpark, Inc.',              'NASDAQ', true,  false),
    ('BYND', 'Beyond Meat',                   'NASDAQ', true,  false),
    ('CHWY', 'Chewy, Inc.',                   'NYSE',   true,  false),
    ('DKNG', 'DraftKings Inc.',               'NASDAQ', true,  false),
    ('LUV',  'Southwest Airlines',            'NYSE',   true,  true),
    ('CCL',  'Carnival Corp.',                'NYSE',   true,  false),
    ('WBD',  'Warner Bros. Discovery',        'NASDAQ', true,  false),
    ('PARA', 'Paramount Global',              'NASDAQ', true,  false),
    ('INTU', 'Intuit Inc.',                   'NASDAQ', true,  false),
    ('PANW', 'Palo Alto Networks',            'NASDAQ', true,  false),
    ('ANET', 'Arista Networks',               'NYSE',   true,  false),
    ('LRCX', 'Lam Research',                  'NASDAQ', true,  false),
    ('AMAT', 'Applied Materials',             'NASDAQ', true,  false),
    ('KLAC', 'KLA Corp.',                     'NASDAQ', true,  false),
    ('ADI',  'Analog Devices',                'NASDAQ', true,  false),
    ('NXPI', 'NXP Semiconductors',            'NASDAQ', true,  false),
    ('GEV',  'GE Vernova Inc.',               'NYSE',   true,  false),
    ('GE',   'GE Aerospace',                  'NYSE',   true,  false),
    ('CRWV', 'CoreWeave, Inc.',               'NASDAQ', true,  false),
    ('SNDK', 'Sandisk Corp.',                 'NASDAQ', true,  false),
    ('HIMS', 'Hims & Hers Health',            'NYSE',   true,  false),
    ('SOUN', 'SoundHound AI',                 'NASDAQ', true,  false),
    ('IONQ', 'IonQ, Inc.',                    'NYSE',   true,  false),
    ('RGTI', 'Rigetti Computing',             'NASDAQ', true,  false),
    ('ASTS', 'AST SpaceMobile',               'NASDAQ', true,  false),
    ('ACHR', 'Archer Aviation',               'NYSE',   true,  false),
    ('JOBY', 'Joby Aviation',                 'NYSE',   true,  false),
    ('OKLO', 'Oklo Inc.',                     'NYSE',   true,  false),
    ('SMR',  'NuScale Power',                 'NYSE',   true,  false),
    ('VST',  'Vistra Corp.',                  'NYSE',   true,  false),
    ('CEG',  'Constellation Energy',          'NASDAQ', true,  false),
    ('TLT',  'iShares 20+ Year Treasury',     'NASDAQ', true,  false),
    ('GLD',  'SPDR Gold Shares',              'NYSEARCA', true, false),
    ('SLV',  'iShares Silver Trust',          'NYSEARCA', true, false),
    ('VXX',  'iPath S&P 500 VIX',             'NYSEARCA', true, false)
ON CONFLICT ("ticker") DO NOTHING;

-- Symbols that are also ordinary words. Flagged rather than excluded: they are
-- real securities, so `$ON` and "ON Semiconductor" must still resolve — only
-- the bare uppercase form is held to a higher bar.
UPDATE "tickers" SET "is_common_word" = true
 WHERE "ticker" IN ('AI', 'ON', 'NOW', 'TEAM', 'ARM', 'F', 'V', 'MA', 'T',
                    'COST', 'SNAP', 'SPOT', 'SNOW', 'NET', 'LUV', 'GO', 'ALL',
                    'CAR', 'GOOD', 'HAS', 'ARE', 'ANY', 'BIG', 'EAT', 'FAST',
                    'HOPE', 'LOVE', 'OPEN', 'PLAY', 'REAL', 'RUN', 'SAVE',
                    'TRUE', 'TURN', 'WELL', 'WORK', 'BEST', 'EDIT', 'MOVE');

-- ---------------------------------------------------------------------------
-- Aliases
-- ---------------------------------------------------------------------------
--
-- ALPHABET — THE DOCUMENTED RULE (spec §6 asks for one rather than an
-- arbitrary pick):
--
--   "Alphabet" and "Google" map to GOOGL, the voting class, because that is the
--   line r/wallstreetbets quotes by default and the class the ticker strip
--   already carries. GOOG is reachable ONLY by an explicit "$GOOG"/"GOOG"
--   mention — an unambiguous statement of share class by the author. We never
--   attach both from one company-name mention: two badges for one company would
--   double the symbol's mention count and skew Popular Tickers and Arena.
--
-- Ambiguity is handled by `requires_context`, not by omission. "Apple" is in
-- the table but needs a financial cue; "I ate an apple" produces nothing while
-- "I bought Apple stock" produces AAPL.

INSERT INTO "ticker_aliases" ("alias", "ticker", "requires_context") VALUES
    ('nvidia',            'NVDA', false),
    ('microsoft',         'MSFT', false),
    ('alphabet',          'GOOGL', false),
    ('google',            'GOOGL', false),
    ('palantir',          'PLTR', false),
    ('reddit',            'RDDT', true),
    ('uber',              'UBER', true),
    ('lyft',              'LYFT', false),
    ('airbnb',            'ABNB', false),
    ('tesla',             'TSLA', false),
    ('netflix',           'NFLX', false),
    ('gamestop',          'GME',  false),
    ('robinhood',         'HOOD', false),
    ('coinbase',          'COIN', false),
    ('broadcom',          'AVGO', false),
    ('qualcomm',          'QCOM', false),
    ('salesforce',        'CRM',  false),
    ('servicenow',        'NOW',  false),
    ('atlassian',         'TEAM', false),
    ('cloudflare',        'NET',  false),
    ('crowdstrike',       'CRWD', false),
    ('snowflake',         'SNOW', true),
    ('datadog',           'DDOG', false),
    ('shopify',           'SHOP', false),
    ('paypal',            'PYPL', false),
    ('oracle',            'ORCL', false),
    ('adobe',             'ADBE', false),
    ('intel',             'INTC', false),
    ('micron',            'MU',   false),
    ('seagate',           'STX',  false),
    ('sandisk',           'SNDK', false),
    ('coreweave',         'CRWV', false),
    ('moderna',           'MRNA', false),
    ('pfizer',            'PFE',  false),
    ('boeing',            'BA',   false),
    ('rivian',            'RIVN', false),
    ('lucid',             'LCID', true),
    ('starbucks',         'SBUX', false),
    ('walmart',           'WMT',  false),
    ('costco',            'COST', false),
    ('disney',            'DIS',  false),
    ('chipotle',          'CMG',  false),
    ('draftkings',        'DKNG', false),
    ('spotify',           'SPOT', true),
    ('roku',              'ROKU', false),
    ('alibaba',           'BABA', false),
    ('microstrategy',     'MSTR', false),
    ('ionq',              'IONQ', false),
    ('rigetti',           'RGTI', false),
    ('soundhound',        'SOUN', false),
    ('supermicro',        'SMCI', false),
    ('super micro',       'SMCI', false),
    ('western digital',   'WDC',  false),
    ('texas instruments', 'TXN',  false),
    ('applied materials', 'AMAT', false),
    ('lam research',      'LRCX', false),
    ('arista',            'ANET', false),
    ('palo alto',         'PANW', true),
    ('taiwan semi',       'TSM',  false),
    ('tsmc',              'TSM',  false),
    -- Everyday words that are also companies. Present, but context-gated.
    ('apple',             'AAPL', true),
    ('amazon',            'AMZN', true),
    ('meta',              'META', true),
    ('facebook',          'META', true),
    ('block',             'SQ',   true),
    ('square',            'SQ',   true),
    ('target',            'TGT',  true),
    ('ford',              'F',    true),
    ('visa',              'V',    true),
    ('nike',              'NKE',  true),
    ('arm',               'ARM',  true),
    ('carnival',          'CCL',  true),
    ('paramount',         'PARA', true),
    ('c3.ai',             'AI',   false),
    ('c3 ai',             'AI',   false)
-- Every alias above resolves to a symbol inserted earlier in this migration;
-- the FK would reject anything else, which is the intended safety net.
ON CONFLICT ("alias") DO NOTHING;
