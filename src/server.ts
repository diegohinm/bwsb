import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { env, isProduction } from "./config/env.js";
import { sessionMiddleware } from "./lib/sessionStore.js";
import { healthRouter } from "./routes/health.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { tickersRouter } from "./routes/tickers.routes.js";
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
    origin: env.FRONTEND_URL,
    credentials: true,
  }),
);

// Body parsing.
app.use(express.json());

// Server-side sessions (PostgreSQL-backed) — must come before any route that
// reads or writes req.session.
app.use(sessionMiddleware);

// Request logging.
app.use(morgan("dev"));

// Routes.
app.use(healthRouter);
app.use("/auth", authRouter);
app.use("/api", tickersRouter);

// 404 + error handling (must come last).
app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`BWSB backend running on ${env.BACKEND_URL}`);
});
