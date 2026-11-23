/**
 * The rules that decide whether the integration suite may touch a database.
 *
 * The integration suite writes (fixtures, created and removed by the tests
 * themselves), so it must only ever reach the dedicated Supabase TEST project.
 * There is no reliable way to recognise "production" from a connection string,
 * so the suite instead demands positive evidence that it is pointed somewhere
 * disposable, and refuses on any evidence to the contrary:
 *
 *  1. TEST_DATABASE=true — an explicit opt-in nobody sets by accident.
 *  2. NODE_ENV is not "production".
 *  3. DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY all come from the
 *     ENVIRONMENT. This is evaluated before any module has loaded a .env file
 *     (see requireTestDatabase.ts), and a developer's .env points at the real
 *     project — so a half-configured shell can never be completed from it.
 *  4. When SUPABASE_URL is a `https://<ref>.supabase.co` URL, DATABASE_URL must
 *     name the same project ref (pooler user `postgres.<ref>`, or direct host
 *     `db.<ref>.supabase.co`). A test API URL paired with another project's
 *     database is exactly the copy-paste slip this exists to catch.
 *
 * Messages name variables, never values. Mirrored in scripts/setup-test-db.sh —
 * keep the two in step.
 *
 * Pure: no imports, no side effects, so the unit suite can pin every rule.
 */

export const REQUIRED_TEST_ENV = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

/** Every reason to refuse; an empty list means the suite may proceed. */
export function testDatabaseRefusals(environment: Environment): string[] {
  const refusals: string[] = [];

  if (environment.TEST_DATABASE !== "true") {
    refusals.push("TEST_DATABASE=true is not set");
  }
  if (environment.NODE_ENV === "production") {
    refusals.push("NODE_ENV=production");
  }

  const missing = REQUIRED_TEST_ENV.filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    refusals.push(
      `missing ${missing.join(", ")} — set them in the environment itself; a .env file is never used for them here`,
    );
  }

  const ref = supabaseProjectRef(environment.SUPABASE_URL);
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (ref && databaseUrl && !databaseUrlNamesProject(databaseUrl, ref)) {
    refusals.push("DATABASE_URL does not belong to the Supabase project named by SUPABASE_URL");
  }

  return refusals;
}

/** The project ref of a `https://<ref>.supabase.co` URL; null for anything else. */
export function supabaseProjectRef(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(new URL(url.trim()).hostname);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Whether the URL's user, host or query names `ref`. The password is never read. */
function databaseUrlNamesProject(databaseUrl: string, ref: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const visible = `${decodeURIComponent(url.username)} ${url.hostname} ${decodeURIComponent(url.search)}`;
    return visible.toLowerCase().includes(ref);
  } catch {
    return false;
  }
}
