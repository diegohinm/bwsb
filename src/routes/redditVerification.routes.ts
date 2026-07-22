import { Router } from "express";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { logAuthEvent } from "../services/auth/authEvents.service.js";
import {
  startRedditVerification,
  markRedditVerificationSent,
  getRedditVerificationStatus,
  getPendingRedditVerifications,
  adminApproveRedditVerification,
  adminRejectRedditVerification,
  unlinkRedditAccount,
} from "../services/reddit/redditVerification.service.js";

/**
 * Optional Reddit username verification.
 *
 * User routes require a logged-in email account (requireAuth). Admin routes use
 * the x-admin-secret header (requireAdmin). None of this is required to use the
 * app — it only powers a verified badge / rankings / credibility.
 */
export const redditVerificationRouter = Router();

redditVerificationRouter.use("/reddit-verification", requireAuth);

/** POST /api/reddit-verification/start { redditUsername } */
redditVerificationRouter.post(
  "/reddit-verification/start",
  asyncHandler(async (req, res) => {
    const redditUsername =
      typeof req.body?.redditUsername === "string" ? req.body.redditUsername : "";
    if (!redditUsername.trim()) return fail(res, "redditUsername is required", 400);

    try {
      const result = await startRedditVerification(req.user!.id, redditUsername);
      return ok(res, result, 201);
    } catch (err) {
      return fail(res, err instanceof Error ? err.message : "Could not start verification", 400);
    }
  }),
);

/** POST /api/reddit-verification/sent { requestId } */
redditVerificationRouter.post(
  "/reddit-verification/sent",
  asyncHandler(async (req, res) => {
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : "";
    if (!requestId) return fail(res, "requestId is required", 400);

    try {
      await markRedditVerificationSent(req.user!.id, requestId);
      return ok(res, { ok: true, status: "user_claimed_sent" });
    } catch (err) {
      return fail(res, err instanceof Error ? err.message : "Could not update request", 400);
    }
  }),
);

/** GET /api/reddit-verification/status */
redditVerificationRouter.get(
  "/reddit-verification/status",
  asyncHandler(async (req, res) => {
    const status = await getRedditVerificationStatus(req.user!.id);
    return ok(res, status);
  }),
);

/** DELETE /api/reddit-verification/link — unlink the Reddit account. */
redditVerificationRouter.delete(
  "/reddit-verification/link",
  asyncHandler(async (req, res) => {
    await unlinkRedditAccount(req.user!.id);
    return ok(res, { ok: true });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Admin review (x-admin-secret)
// ═══════════════════════════════════════════════════════════════════════════
export const adminRedditVerificationRouter = Router();

adminRedditVerificationRouter.use("/reddit-verifications", requireAdmin);

/** GET /admin/reddit-verifications/pending */
adminRedditVerificationRouter.get(
  "/reddit-verifications/pending",
  asyncHandler(async (_req, res) => {
    const pending = await getPendingRedditVerifications();
    return ok(res, pending);
  }),
);

/** POST /admin/reddit-verifications/:requestId/approve { adminNotes? } */
adminRedditVerificationRouter.post(
  "/reddit-verifications/:requestId/approve",
  asyncHandler(async (req, res) => {
    const adminNotes =
      typeof req.body?.adminNotes === "string" ? req.body.adminNotes : undefined;
    try {
      await adminApproveRedditVerification(req.params.requestId, adminNotes);
      await logAuthEvent({
        eventType: "reddit_verification_approved",
        success: true,
        userAgent: req.header("user-agent") ?? null,
      });
      return ok(res, { ok: true });
    } catch (err) {
      return fail(res, err instanceof Error ? err.message : "Could not approve", 400);
    }
  }),
);

/** POST /admin/reddit-verifications/:requestId/reject { adminNotes? } */
adminRedditVerificationRouter.post(
  "/reddit-verifications/:requestId/reject",
  asyncHandler(async (req, res) => {
    const adminNotes =
      typeof req.body?.adminNotes === "string" ? req.body.adminNotes : undefined;
    try {
      await adminRejectRedditVerification(req.params.requestId, adminNotes);
      await logAuthEvent({
        eventType: "reddit_verification_rejected",
        success: true,
        userAgent: req.header("user-agent") ?? null,
      });
      return ok(res, { ok: true });
    } catch (err) {
      return fail(res, err instanceof Error ? err.message : "Could not reject", 400);
    }
  }),
);
