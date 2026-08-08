import { Router } from "express";
import multer from "multer";

import { ok, fail, asyncHandler } from "../lib/response.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { logAuthEvent } from "../services/auth/authEvents.service.js";
import { SESSION_COOKIE_NAME } from "../services/auth/session.service.js";
import { getPortfolioSummary } from "../services/portfolio/portfolioSummary.service.js";
import { getAuthUserById } from "../services/auth/session.service.js";
import {
  AvatarValidationError,
  MAX_AVATAR_BYTES,
  removeAvatar,
  replaceAvatar,
} from "../services/storage/avatarStorage.service.js";
import {
  AccountValidationError,
  EmailInUseError,
  InvalidCredentialsError,
  changePassword,
  hasLocalPassword,
  updateProfile,
  DISPLAY_NAME_MIN,
  DISPLAY_NAME_MAX,
} from "../services/auth/accountProfile.service.js";

/**
 * AUTHENTICATED SELF-SERVICE — the caller's own portfolio and account.
 *
 * Every route here is behind `requireAuth` and derives the user from the
 * SESSION. None of them read a user id from the body, the query or a header, so
 * there is no request that reaches another account's data.
 */

export const meAccountRouter = Router();

meAccountRouter.use(requireAuth);

// Account mutations are security-sensitive; both are throttled per IP. The
// password endpoint is tighter because it is the one worth guessing against.
const profileLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "me-profile" });
const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: "me-password" });
const avatarLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: "me-avatar" });

/**
 * In MEMORY, with a hard byte ceiling.
 *
 * Nothing is written to disk: an unvalidated upload should never become a file
 * on the server, and the limit is enforced by multer before the buffer exists
 * rather than after — a 500 MB body must be refused while it streams, not once
 * it is resident.
 */
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
});

function ipOf(req: { ip?: string; socket: { remoteAddress?: string } }): string | null {
  return req.ip || req.socket.remoteAddress || null;
}

/**
 * GET /api/me/portfolio/summary
 *
 * THE canonical portfolio figures. The sidebar, the header and the account page
 * all read this one response, which is what makes their numbers agree.
 */
meAccountRouter.get(
  "/me/portfolio/summary",
  asyncHandler(async (req, res) => {
    const summary = await getPortfolioSummary(req.user!.id);
    return ok(res, summary);
  }),
);

/** GET /api/me/account-status — what the account page needs to render its forms. */
meAccountRouter.get(
  "/me/account-status",
  asyncHandler(async (req, res) =>
    ok(res, {
      hasPassword: await hasLocalPassword(req.user!.id),
      displayNameMin: DISPLAY_NAME_MIN,
      displayNameMax: DISPLAY_NAME_MAX,
    }),
  ),
);

/**
 * PATCH /api/me/profile
 * Body: { displayName?, email? }
 *
 * Changing the email resets its verified state and sends a fresh link — the
 * account has not proved control of the new address.
 */
meAccountRouter.patch(
  "/me/profile",
  profileLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const result = await updateProfile(req.user!.id, {
        displayName: body.displayName,
        email: body.email,
      });

      await logAuthEvent({
        userId: req.user!.id,
        eventType: result.emailChanged ? "email_changed" : "profile_updated",
        success: true,
        ipAddress: ipOf(req),
        userAgent: req.header("user-agent") ?? null,
      });

      return ok(res, result);
    } catch (err) {
      if (err instanceof EmailInUseError) {
        // Inside an AUTHENTICATED update this is not enumeration: the caller
        // already proved who they are and has to be told why the save failed.
        return fail(res, err.message, 409);
      }
      if (err instanceof AccountValidationError) return fail(res, err.message, 400);
      throw err;
    }
  }),
);

/**
 * POST /api/me/avatar — multipart/form-data, field `avatar`.
 *
 * The user is the SESSION's user. Nothing about the destination comes from the
 * request: not the id, not the filename, not the extension.
 */
meAccountRouter.post(
  "/me/avatar",
  avatarLimiter,
  avatarUpload.single("avatar"),
  asyncHandler(async (req, res) => {
    const file = (req as unknown as { file?: { buffer: Buffer } }).file;
    if (!file?.buffer) return fail(res, "No image was uploaded.", 400);

    try {
      const { avatarUrl } = await replaceAvatar(req.user!.id, file.buffer);
      await logAuthEvent({
        userId: req.user!.id,
        eventType: "avatar_updated",
        success: true,
        ipAddress: ipOf(req),
        userAgent: req.header("user-agent") ?? null,
      });
      // The full safe user, so the client can refresh identity everywhere from
      // one response. getAuthUserById never selects passwordHash.
      return ok(res, { avatarUrl, user: await getAuthUserById(req.user!.id) });
    } catch (err) {
      if (err instanceof AvatarValidationError) return fail(res, err.message, 400);
      throw err;
    }
  }),
);

/** DELETE /api/me/avatar — back to the shared default frog. */
meAccountRouter.delete(
  "/me/avatar",
  avatarLimiter,
  asyncHandler(async (req, res) => {
    const { avatarUrl } = await removeAvatar(req.user!.id);
    return ok(res, { avatarUrl, user: await getAuthUserById(req.user!.id) });
  }),
);

/**
 * POST /api/me/change-password
 * Body: { currentPassword, newPassword }
 *
 * The confirmation field is frontend-only — it protects against a typo, and
 * there is nothing for the server to do with a second copy of the same string.
 */
meAccountRouter.post(
  "/me/change-password",
  passwordLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const result = await changePassword(
        req.user!.id,
        body.currentPassword,
        body.newPassword,
        // Keep the caller's own session alive; revoke every other one.
        typeof req.cookies?.[SESSION_COOKIE_NAME] === "string"
          ? (req.cookies[SESSION_COOKIE_NAME] as string)
          : undefined,
      );

      await logAuthEvent({
        userId: req.user!.id,
        eventType: "password_changed",
        success: true,
        ipAddress: ipOf(req),
        userAgent: req.header("user-agent") ?? null,
      });

      // Never echo a password, a hash, or anything derived from either.
      return ok(res, {
        ok: true,
        revokedSessions: result.revokedSessions,
      });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        await logAuthEvent({
          userId: req.user!.id,
          eventType: "password_changed",
          success: false,
          ipAddress: ipOf(req),
          userAgent: req.header("user-agent") ?? null,
        });
        return fail(res, err.message, 400);
      }
      if (err instanceof AccountValidationError) return fail(res, err.message, 400);
      // The password policy throws a plain Error with a user-facing message.
      if (err instanceof Error && /password/i.test(err.message)) {
        return fail(res, err.message, 400);
      }
      throw err;
    }
  }),
);
