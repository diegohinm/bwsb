/**
 * Single source of truth for the public brand on the backend. Emails, health
 * payloads and log banners must read from here instead of hardcoding a name.
 *
 * Casing is significant: the product is **YOLOPulse** (capital YOLO + Pulse).
 * `YoloPulse`, `YOLOpulse`, `YoloTerminal` and `StonkTerminal` are retired names
 * and must not appear in any user-visible string.
 */
export const BRANDING = {
  productName: "YOLOPulse",
  internalProjectName: "wsb",
  backendName: "bwsb",
  frontendName: "fwsb",
  serviceName: "yolopulse-bwsb",
  tagline: "Retail sentiment terminal",
  description:
    "Track retail sentiment, verified positions and trader performance.",
  /** Retired names — listed only so tooling/tests can assert they are gone. */
  retiredNames: ["StonkTerminal", "YoloTerminal", "YoloPulse", "YOLOpulse"],
} as const;

/**
 * Global default profile avatar. A LOCAL frontend asset (served from
 * fwsb/public/avatars/) — never an external URL. Every user without a
 * personalized avatar resolves to this image. Stored on app_users.avatar_url
 * for new accounts and used as the fallback everywhere in the UI.
 */
export const DEFAULT_AVATAR_URL = "/avatars/default-frog.svg";
export const DEFAULT_AVATAR_TYPE = "default_frog";

/**
 * Retired default-avatar paths. Rows still pointing at one of these are NOT
 * personalized avatars — they were written by an earlier default and now 404,
 * so migrations may safely repoint them at DEFAULT_AVATAR_URL. Custom avatars
 * (anything not in this list) are never touched.
 */
export const RETIRED_DEFAULT_AVATAR_URLS = [
  "/avatars/default-frog.png",
] as const;
