import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { env, isProduction, isRedditOAuthConfigured } from "./config/env.js";
import { BRANDING } from "./config/branding.js";
import { getSocialProviderStatus } from "./services/social/index.js";
import { sessionMiddleware } from "./lib/sessionStore.js";
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
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { marketDataRouter } from "./routes/marketData.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { personalRouter } from "./routes/personal.routes.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

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
app.use("/api", dashboardRouter);
// Public market data (equities / extended-hours / options; license-gated, no auth).
app.use("/api", marketDataRouter);
app.use("/api", productRouter);
// Optional Reddit username verification (requireAuth applied inside the router).
app.use("/api", redditVerificationRouter);
// Admin review endpoints (x-admin-secret applied inside the router).
app.use("/admin", adminRedditVerificationRouter);
// Protected personal features (requireAuth applied inside the router). Mounted
// after the public routers so public routes are handled without auth.
app.use("/api", personalRouter);

// 404 + error handling (must come last).
app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(
    `${BRANDING.productName} backend (${BRANDING.backendName}) running on ${env.BACKEND_URL}`,
  );
  console.log(
    `Reddit OAuth: ${
      isRedditOAuthConfigured ? "configured" : "NOT configured (email auth only)"
    }`,
  );
  void getSocialProviderStatus().then((social) => {
    console.log(
      `Social data provider: ${social.provider} (${social.status})${
        social.message ? ` — ${social.message}` : ""
      }`,
    );
  });
});
