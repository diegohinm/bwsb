import type { PublicUser } from "../services/user.js";

/**
 * Augments Express's Request with the optionally-attached authenticated user.
 * `req.user` is set by optionalAuth (when a valid session exists) and
 * guaranteed present after requireAuth.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export {};
