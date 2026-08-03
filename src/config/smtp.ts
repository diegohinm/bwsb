import "dotenv/config";

/**
 * Reads `process.env` DIRECTLY rather than the parsed `env` object.
 *
 * Deliberate: env.ts parses once at import time, so a module that closes over
 * it cannot be exercised with different configurations — and this is precisely
 * the module whose parsing rules needed tests. Everything here is an optional
 * string with hand-written normalization, so zod was adding nothing but a
 * second place for the SMTP variable names to drift.
 */

/**
 * THE SMTP CONFIGURATION. One place, derived once, read by everything.
 *
 * Three normalizations here exist because each one caused a real failure:
 *
 *   1. THE PASSWORD IS STRIPPED OF WHITESPACE. Google shows an app password as
 *      four groups of four ("abcd efgh ijkl mnop"). Pasted verbatim that is a
 *      19-character string, and Gmail answers `535-5.7.8 Username and Password
 *      not accepted`. The 16 characters are the password; the spaces are
 *      presentation.
 *   2. SECURE IS DERIVED FROM THE PORT unless explicitly overridden. Port 465 is
 *      implicit TLS and needs secure:true; 587 is STARTTLS and needs
 *      secure:false. The old default (`false`) silently broke every 465 config.
 *   3. BOTH SPELLINGS ARE READ. An operator who sets SMTP_PASSWORD or SMTP_FROM
 *      should not be quietly ignored because the code happened to read
 *      SMTP_PASS and EMAIL_FROM.
 *
 * Nothing in this module logs the password, and `describeSmtp()` is the only
 * shape allowed near a console.
 */

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

const DEFAULT_HOST = "smtp.gmail.com";
const DEFAULT_PORT = 465;
/** Ports whose protocol is implicit TLS from the first byte. */
const IMPLICIT_TLS_PORTS = new Set([465]);

function readPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `SMTP_PORT must be a valid TCP port number. Received: ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

/**
 * Explicit SMTP_SECURE wins; otherwise the port decides. Deriving is the right
 * default because the two are not independent — 465 with secure:false hangs and
 * 587 with secure:true never negotiates.
 */
function readSecure(raw: string | undefined, port: number): boolean {
  if (raw !== undefined) {
    const value = raw.trim().toLowerCase();
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return IMPLICIT_TLS_PORTS.has(port);
}

/** Raw, unvalidated view of what the environment provides. */
function read(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRaw() {
  const port = readPort(read("SMTP_PORT"));
  const user = read("SMTP_USER");
  // Whitespace is stripped, not trimmed: the spaces Google prints inside an app
  // password are the failure this whole module exists to prevent.
  const password = (read("SMTP_PASSWORD") ?? read("SMTP_PASS"))?.replace(/\s/g, "");
  return {
    host: read("SMTP_HOST") || DEFAULT_HOST,
    port,
    secure: readSecure(read("SMTP_SECURE"), port),
    user,
    password: password && password.length > 0 ? password : undefined,
    from: read("SMTP_FROM") || read("EMAIL_FROM") || user,
  };
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

/** DEV_EMAIL_MODE defaults to true so local development needs no SMTP at all. */
function devEmailMode(): boolean {
  const raw = read("DEV_EMAIL_MODE");
  if (raw === undefined) return true;
  const value = raw.toLowerCase();
  return value === "true" || value === "1";
}

/**
 * True when a real send could be attempted. Credentials are part of the answer:
 * a host and port with no login is not "configured", it is a connection that
 * will be refused at AUTH.
 */
export function isSmtpConfigured(): boolean {
  const raw = (() => {
    try {
      return readRaw();
    } catch {
      return null;
    }
  })();
  return Boolean(raw?.host && raw.port && raw.user && raw.password);
}

/**
 * Print links to the console instead of sending.
 *
 * Explicit DEV_EMAIL_MODE, or simply no usable SMTP config — but NEVER in
 * production, where silently logging a verification link instead of delivering
 * it would look like success and strand every new user.
 */
export function useConsoleEmailMode(): boolean {
  if (isProductionEnv()) return false;
  return devEmailMode() || !isSmtpConfigured();
}

/**
 * The validated configuration. Throws a configuration error naming exactly what
 * is missing — an EAUTH at send time is a far worse way to learn this.
 */
export function getSmtpConfig(): SmtpConfig {
  const raw = readRaw();

  const missing: string[] = [];
  if (!raw.user) missing.push("SMTP_USER");
  if (!raw.password) missing.push("SMTP_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `SMTP configuration is incomplete. ${missing.join(" and ")} ${
        missing.length === 1 ? "is" : "are"
      } required.`,
    );
  }

  return {
    host: raw.host,
    port: raw.port,
    secure: raw.secure,
    user: raw.user!,
    password: raw.password!,
    from: raw.from || raw.user!,
  };
}

/**
 * A log-safe description of the configuration.
 *
 * `passwordLength` is here on purpose: it is the one number that distinguishes
 * a correct 16-character Google app password from a pasted 19-character one or
 * from an ordinary account password, and it reveals nothing usable.
 */
export function describeSmtp(): Record<string, unknown> {
  let raw: ReturnType<typeof readRaw> | null = null;
  let error: string | null = null;
  try {
    raw = readRaw();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    host: raw?.host ?? null,
    port: raw?.port ?? null,
    secure: raw?.secure ?? null,
    user: raw?.user ?? null,
    from: raw?.from ?? null,
    passwordConfigured: Boolean(raw?.password),
    passwordLength: raw?.password?.length ?? 0,
    consoleMode: useConsoleEmailMode(),
    ...(error ? { error } : {}),
  };
}
