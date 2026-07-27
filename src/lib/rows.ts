import { Prisma } from "@prisma/client";

/**
 * Map Prisma rows back to their DATABASE column names.
 *
 * Prisma models are camelCase; the columns (and therefore the JSON the API has
 * always returned) are snake_case. Analytics and reference reads are serialized
 * straight onto the wire, so the key names are part of the API contract and must
 * not change just because the data-access layer did.
 *
 * The mapping is read from Prisma's own DMMF — each field's `dbName` is the
 * exact `@map(...)` target — rather than guessed with a camelCase-to-snake_case
 * regex. It therefore stays correct for any column the regex would get wrong,
 * and a renamed column is reflected automatically after `prisma generate`.
 *
 * Values are normalized the way the domain types in src/types/domain.ts declare
 * them: `numeric` columns become numbers (the pg driver used to hand back
 * strings). Money that must not pass through a float — virtual accounts,
 * portfolio positions — is deliberately NOT routed through here; those
 * repositories keep Decimal as a string.
 */

/** Prisma model name → (field name → database column name). */
const COLUMN_NAMES = new Map<string, Map<string, string>>();

function columnNames(model: string): Map<string, string> {
  const cached = COLUMN_NAMES.get(model);
  if (cached) return cached;

  const definition = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!definition) {
    throw new Error(`toDbRow: unknown Prisma model "${model}"`);
  }

  const map = new Map(
    definition.fields
      // Relation fields have no column of their own.
      .filter((f) => f.kind !== "object")
      .map((f) => [f.name, f.dbName ?? f.name]),
  );
  COLUMN_NAMES.set(model, map);
  return map;
}

function toColumnValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

/** One row, keyed by database column name. */
export function toDbRow<T = Record<string, unknown>>(
  model: string,
  row: Record<string, unknown>,
): T {
  const names = columnNames(model);
  const out: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(row)) {
    // A key with no column (an included relation) is passed through untouched.
    out[names.get(field) ?? field] = toColumnValue(value);
  }

  return out as T;
}

/** Many rows, keyed by database column name. */
export function toDbRows<T = Record<string, unknown>>(
  model: string,
  rows: Record<string, unknown>[],
): T[] {
  return rows.map((row) => toDbRow<T>(model, row));
}
