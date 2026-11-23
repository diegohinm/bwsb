// FIRST: nothing that writes may be reached without the test-database guard.
import "./requireTestDatabase.js";

import { prisma } from "../lib/prisma.js";
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";
import { AVATAR_BUCKET } from "../services/storage/avatarStorage.service.js";

/**
 * Deterministic fixtures for the integration suite.
 *
 * Every row or object a test writes is created BY THAT TEST, under an
 * identifier that is unmistakably ours (`ci_` / `integration_` names, a fixed
 * `c1000000-…` uuid, an address on the reserved `.invalid` TLD that can never
 * receive mail), and is removed again by exactly that identifier. Nothing here
 * deletes by pattern, truncates a table, or touches a row the suite did not
 * create — so no test depends on, or disturbs, whatever else the test project
 * holds.
 *
 * A run that crashed mid-test leaves its fixtures behind. Each suite therefore
 * removes its own identifiers BEFORE creating them as well as after, so a
 * leftover can never change an outcome.
 *
 * Fixed identifiers are safe because CI runs the integration job one at a time
 * (a single `concurrency` group for the one Supabase test project).
 */

export interface FixtureUser {
  id: string;
  email: string;
  displayName: string;
}

/** Database round trip (database.test.ts). */
export const CI_USER_001: FixtureUser = {
  id: "c1000000-0000-4000-8000-000000000001",
  email: "ci_user_001@example.invalid",
  displayName: "integration_user_001",
};

/** Avatar storage round trip (supabase.test.ts). */
export const CI_USER_002: FixtureUser = {
  id: "c1000000-0000-4000-8000-000000000002",
  email: "ci_user_002@example.invalid",
  displayName: "integration_user_002",
};

export async function createFixtureUser(user: FixtureUser): Promise<{ id: string }> {
  return prisma.appUsers.create({
    data: {
      id: user.id,
      email: user.email,
      emailNormalized: user.email,
      displayName: user.displayName,
    },
    select: { id: true },
  });
}

/** Remove the fixture user — matched on its exact address, never a pattern. */
export async function removeFixtureUser(user: FixtureUser): Promise<void> {
  await prisma.appUsers.deleteMany({ where: { email: user.email } });
}

/** Whether the test project has the bucket the API uploads avatars to. */
export async function avatarBucketExists(): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().storage.listBuckets();
  if (error) throw new Error(`Could not list storage buckets: ${error.message}`);
  return data.some((bucket) => bucket.id === AVATAR_BUCKET || bucket.name === AVATAR_BUCKET);
}

/** Keys stored under the fixture user's own prefix — the only place the app writes for them. */
export async function listFixtureAvatarKeys(user: FixtureUser): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin().storage.from(AVATAR_BUCKET).list(user.id);
  if (error) throw new Error(`Could not list fixture avatars: ${error.message}`);
  return (data ?? []).map((object) => `${user.id}/${object.name}`);
}

/** Remove every object under the fixture user's prefix, and nothing else. */
export async function removeFixtureAvatarObjects(user: FixtureUser): Promise<void> {
  const keys = await listFixtureAvatarKeys(user);
  if (keys.length === 0) return;
  const { error } = await getSupabaseAdmin().storage.from(AVATAR_BUCKET).remove(keys);
  if (error) throw new Error(`Could not remove fixture avatars: ${error.message}`);
}
