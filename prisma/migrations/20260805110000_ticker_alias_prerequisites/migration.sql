-- The next two alias migrations reference these symbols from the old seed.
-- A clean deployment runs migrations before seeding. Supply their FK parents
-- here, before either alias migration, without changing any existing ticker.
INSERT INTO "tickers" ("ticker", "company_name", "exchange", "is_active", "is_common_word") VALUES
    ('AAPL',  'Apple Inc.',               'NASDAQ', true, false),
    ('AI',    'C3.ai, Inc.',              'NYSE',   true, true),
    ('AMZN',  'Amazon.com, Inc.',         'NASDAQ', true, false),
    ('COIN',  'Coinbase Global, Inc.',    'NASDAQ', true, false),
    ('CRM',   'Salesforce, Inc.',         'NYSE',   true, false),
    ('GME',   'GameStop Corp.',           'NYSE',   true, false),
    ('GOOGL', 'Alphabet Inc.',            'NASDAQ', true, false),
    ('HOOD',  'Robinhood Markets, Inc.',  'NASDAQ', true, false),
    ('INTC',  'Intel Corporation',       'NASDAQ', true, false),
    ('META',  'Meta Platforms, Inc.',     'NASDAQ', true, false),
    ('MSFT',  'Microsoft Corporation',    'NASDAQ', true, false),
    ('MU',    'Micron Technology, Inc.', 'NASDAQ', true, false),
    ('NFLX',  'Netflix, Inc.',            'NASDAQ', true, false),
    ('NOW',   'ServiceNow, Inc.',         'NYSE',   true, true),
    ('NVDA',  'NVIDIA Corporation',       'NASDAQ', true, false),
    ('ON',    'ON Semiconductor Corp.',  'NASDAQ', true, true),
    ('PLTR',  'Palantir Technologies Inc.', 'NASDAQ', true, false),
    ('RDDT',  'Reddit, Inc.',             'NYSE',   true, false),
    ('TEAM',  'Atlassian Corporation',   'NASDAQ', true, true),
    ('TSLA',  'Tesla, Inc.',              'NASDAQ', true, false)
ON CONFLICT ("ticker") DO NOTHING;
