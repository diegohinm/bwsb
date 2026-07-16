import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.routes.js";
import { tickersRouter } from "./routes/tickers.routes.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

// Security headers.
app.use(helmet());

// Allow the frontend origin only.
app.use(
  cors({
    origin: env.FRONTEND_ORIGIN,
  }),
);

// Body parsing.
app.use(express.json());

// Request logging.
app.use(morgan("dev"));

// Routes.
app.use(healthRouter);
app.use("/api", tickersRouter);

// 404 + error handling (must come last).
app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`BWSB backend running on http://localhost:${env.PORT}`);
});
