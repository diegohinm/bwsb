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
