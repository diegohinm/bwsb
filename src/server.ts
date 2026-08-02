import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { env, isProduction, isRedditOAuthConfigured } from "./config/env.js";
import { BRANDING } from "./config/branding.js";
import { SERVICE_ROLE, providerCallsAllowed } from "./config/serviceRole.js";
import { getSocialProviderStatus } from "./services/social/index.js";
import { sessionMiddleware } from "./lib/sessionStore.js";
import { registerPrismaShutdown } from "./lib/prisma.js";
import { optionalAuth } from "./middleware/optionalAuth.js";
import { healthRouter } from "./routes/health.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import {
  redditVerificationRouter,
  adminRedditVerificationRouter,
} from "./routes/redditVerification.routes.js";
import { tickersRouter } from "./routes/tickers.routes.js";
import { trendsRouter } from "./routes/trends.routes.js";
import { signalsRouter } from "./routes/signals.routes.js";
import { betsRouter } from "./routes/bets.routes.js";
import { backtestsRouter } from "./routes/backtests.routes.js";
import { alertsRouter } from "./routes/alerts.routes.js";
import { screenerRouter } from "./routes/screener.routes.js";
import { researchRouter } from "./routes/research.routes.js";
import { searchRouter } from "./routes/search.routes.js";
import { pulseRouter } from "./routes/pulse.routes.js";
import { wsbRouter } from "./routes/wsb.routes.js";
import { arenaRouter } from "./routes/arena.routes.js";
import { calendarRouter } from "./routes/calendar.routes.js";
import { discussionRouter } from "./routes/discussion.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { marketDataRouter } from "./routes/marketData.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { personalRouter } from "./routes/personal.routes.js";
import { internalRedditRouter } from "./routes/internalReddit.routes.js";
import { internalRedditScannerRouter } from "./routes/internalRedditScannerRoutes.js";
import { attachDiscussionSocket } from "./realtime/discussionSocket.js";
import { discussionSource } from "./realtime/discussionSource.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

/**
 * YOLOPulse API server (bwsb-api).
 *
 * ONE OF TWO PROCESSES. This one serves HTTP and reads the DATABASE ONLY —
 * pulse, ticker strip, quotes and movers are all worker-written snapshots, so a
 * user request never triggers a Mindcase or Databento call. Ingestion lives in
 * src/worker.ts (npm run worker) and is the only process holding provider keys.
 */
const app = express();

// Behind a proxy/load balancer in production so that Secure cookies work and
// the client IP is trusted.
if (isProduction) {
  app.set("trust proxy", 1);
}

// Security headers.
app.use(helmet());

// Allow the frontend origin only, and permit cookies to be sent with requests.
app.use(
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
  }),
);

// Body parsing.
app.use(express.json());

// Cookie parsing — required before optionalAuth reads the yt_session cookie.
app.use(cookieParser());

// Legacy express-session (PostgreSQL-backed) — retained only for the optional/
// future Reddit OAuth handshake (req.session.oauthState / userId).
app.use(sessionMiddleware);

// Best-effort auth: attaches req.user when a valid session exists, but never
// blocks anonymous/public requests.
app.use(optionalAuth);

// Request logging.
app.use(morgan("dev"));

// Routes.
app.use(healthRouter);
app.use("/auth", authRouter);
app.use("/api", tickersRouter);
app.use("/api", trendsRouter);
app.use("/api", signalsRouter);
app.use("/api", betsRouter);
app.use("/api", backtestsRouter);
app.use("/api", alertsRouter);
app.use("/api", screenerRouter);
app.use("/api", researchRouter);
app.use("/api", searchRouter);
// Public cross-subreddit Pulse (social data provider, no auth).
app.use("/api", pulseRouter);
// Public WSB workspace: portfolio snapshots + banbets. Reads the database only;
// /wsb/banbets/me applies requireAuth inside the router.
app.use("/api", wsbRouter);
// Public Arena rankings (read-only, no auth). /arena/me applies requireAuth
// inside the router.
app.use("/api", arenaRouter);
// Public earnings calendar (read-only, no auth). /calendar/me/earnings and the
// preference endpoints apply requireAuth inside the router.
app.use("/api", calendarRouter);
// Public realtime Reddit discussion feed (REST snapshot + SSE fallback). The
// WebSocket transport is attached to the HTTP server below.
app.use("/api", discussionRouter);
app.use("/api", dashboardRouter);
// Public market data (equities / options; license-gated, no auth). Extended
// hours are served only when ENABLE_EXTENDED_HOURS is on — off by default,
// in which case this is the US regular session (09:30-16:00 ET) only.
app.use("/api", marketDataRouter);
app.use("/api", productRouter);
// Optional Reddit username verification (requireAuth applied inside the router).
app.use("/api", redditVerificationRouter);
// Admin review endpoints (x-admin-secret applied inside the router).
app.use("/admin", adminRedditVerificationRouter);
// Internal Reddit provider diagnostics (x-admin-secret applied inside).
app.use("/api", internalRedditRouter);
// Internal Reddit scanner test harness (dev-open, admin-only in production).
app.use("/api/internal/reddit/scanner", internalRedditScannerRouter);
// Protected personal features (requireAuth applied inside the router). Mounted
// after the public routers so public routes are handled without auth.
app.use("/api", personalRouter);

// 404 + error handling (must come last).
app.use(notFound);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  console.log(
    `${BRANDING.productName} API (${BRANDING.backendName}) running on ${env.BACKEND_URL} — role=${SERVICE_ROLE}`,
  );
  console.log(
    `Reddit OAuth: ${
      isRedditOAuthConfigured ? "configured" : "NOT configured (email auth only)"
    }`,
  );
  console.log(
    providerCallsAllowed
      ? "Data: reads DB snapshots; provider calls are ALLOWED in this process (SERVICE_ROLE=all — dev). Run `npm run dev:worker` for ingestion."
      : "Data: reads DB snapshots only — Mindcase/Databento calls are blocked in this process. Ingestion runs in bwsb-worker.",
  );
  void getSocialProviderStatus().then((social) => {
    console.log(
      `Configured social provider: ${social.provider} (${social.status})${
        social.message ? ` — ${social.message}` : ""
      }`,
    );
  });
});

// Realtime Discussion feed shares this HTTP server rather than opening a second
// port: one origin, one TLS certificate, and the existing CORS/proxy setup
// applies unchanged.
const discussionWss = attachDiscussionSocket(server);

// On SIGTERM/SIGINT (a Render redeploy, a local Ctrl-C): stop accepting new
// connections, let in-flight requests finish, then release the Prisma pool.
registerPrismaShutdown("api", async () => {
  discussionSource.stop();
  for (const client of discussionWss.clients) client.close(1001, "Server shutting down");
  discussionWss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
