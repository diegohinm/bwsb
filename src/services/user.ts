import type { User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  resolveAvatarUrl,
  type RedditIdentity,
} from "./reddit.js";

/**
 * Create or update the local user for a Reddit identity.
 *
 * Users are always keyed by `redditId` (stable) — never by username, which can
 * change. On every login we refresh the mutable Reddit profile fields.
 */
export async function upsertUserFromReddit(
  identity: RedditIdentity,
): Promise<User> {
  const redditCreatedAt =
    typeof identity.created_utc === "number"
      ? new Date(identity.created_utc * 1000)
      : null;

  const profile = {
    redditUsername: identity.name,
    redditAvatarUrl: resolveAvatarUrl(identity),
    redditCreatedAt,
    redditHasVerifiedEmail: identity.has_verified_email ?? false,
  };

  return prisma.user.upsert({
    where: { redditId: identity.id },
    create: { redditId: identity.id, ...profile },
    update: profile,
  });
}

/** Fetch a user by local id, or null if not found. */
export function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

/**
 * The user shape safe to return to the frontend. No tokens, secrets, or
 * internal-only fields are ever included.
 */
export interface PublicUser {
  id: string;
  redditId: string;
  redditUsername: string;
  redditAvatarUrl: string | null;
  redditCreatedAt: string | null;
  redditHasVerifiedEmail: boolean;
  email: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    redditId: user.redditId,
    redditUsername: user.redditUsername,
    redditAvatarUrl: user.redditAvatarUrl,
    redditCreatedAt: user.redditCreatedAt
      ? user.redditCreatedAt.toISOString()
      : null,
    redditHasVerifiedEmail: user.redditHasVerifiedEmail,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  };
}
