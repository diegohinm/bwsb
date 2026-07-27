import { Prisma } from "@prisma/client";

/**
 * Convert a PostgreSQL numeric to a JS number without turning null into 0.
 *
 * Prisma returns `numeric`/`decimal` columns as Decimal.js values to preserve
 * precision. The API serializes plain numbers, so the conversion happens once,
 * here — and `null` stays `null` so "no price" is never rendered as "$0".
 */
export function num(
  value: Prisma.Decimal | string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n =
    value instanceof Prisma.Decimal
      ? value.toNumber()
      : typeof value === "number"
        ? value
        : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Same conversion, with a fallback for callers that need a non-null number. */
export function numOr(
  value: Prisma.Decimal | string | number | null | undefined,
  fallback: number,
): number {
  return num(value) ?? fallback;
}
