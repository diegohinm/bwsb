-- Company names for the symbols whose ticker is also an everyday word.
--
-- A bare uppercase mention of these no longer reaches display confidence: live
-- data showed that "AI", "ON", "NOW" and friends are almost always the English
-- word, so the extractor now demands evidence the author supplied. That leaves
-- two doors open — an explicit `$` cashtag, and the company name — and the
-- second one only works if the name is in this table.
--
-- Without these rows, "ON Semiconductor beat estimates" or "Southwest raised
-- guidance" would silently stop resolving. The strictness is meant to remove
-- false positives, not real mentions.

INSERT INTO "ticker_aliases" ("alias", "ticker", "requires_context") VALUES
    ('on semiconductor',  'ON',   false),
    ('onsemi',            'ON',   false),
    ('arm holdings',      'ARM',  false),
    ('mastercard',        'MA',   false),
    ('southwest',         'LUV',  true),
    ('southwest airlines','LUV',  false),
    ('at&t',              'T',    false),
    ('snapchat',          'SNAP', false),
    ('ford motor',        'F',    false)
ON CONFLICT ("alias") DO NOTHING;
