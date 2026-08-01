import { Router } from "express";

import { asyncHandler } from "../lib/response.js";
import { requireInternalOrAdmin } from "../middleware/requireInternalOrAdmin.js";
import { validateRedditScannerRequest } from "../middleware/validateRedditScannerRequest.js";
import { testRedditScanner } from "../controllers/internalRedditScannerController.js";

/**
 * Internal Reddit scanner test harness.
 *
 *   POST /api/internal/reddit/scanner/test
 *
 * Mounted under that prefix in server.ts. Development is open; production
 * requires an admin (ADMIN_EMAILS allowlist or the x-admin-secret header) — see
 * middleware/requireInternalOrAdmin.ts.
 *
 * This is the ONLY route in the app that triggers a live provider call from an
 * HTTP request. It is deliberate and gated: normal user traffic always reads
 * PostgreSQL. Note that with SERVICE_ROLE=api the process-level guard in
 * config/serviceRole.ts still blocks the upstream call, so on a split
 * deployment this endpoint reports the guard error rather than reaching out.
 */
export const internalRedditScannerRouter = Router();

internalRedditScannerRouter.post(
  "/test",
  requireInternalOrAdmin,
  validateRedditScannerRequest,
  asyncHandler(testRedditScanner),
);
