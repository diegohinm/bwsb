// FIRST: refuses unless TEST_DATABASE=true and the test project is configured.
import "./requireTestDatabase.js";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { DEFAULT_AVATAR_URL } from "../config/branding.js";
import { disconnectPrisma, prisma } from "../lib/prisma.js";
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";
import {
  AVATAR_BUCKET,
  removeAvatar,
  replaceAvatar,
} from "../services/storage/avatarStorage.service.js";
import {
  CI_USER_002,
  avatarBucketExists,
  createFixtureUser,
  listFixtureAvatarKeys,
  removeFixtureAvatarObjects,
  removeFixtureUser,
} from "./fixtures.js";

/**
 * The Supabase API, used the way the app uses it: the service-role admin client
 * and avatar Storage. These are the only external calls the integration suite
 * makes — everything else (Mindcase, Arctic Shift, Databento, SMTP, Reddit) is
 * mocked in the unit suite and never reached here.
 */

/**
 * The smallest bytes validateAvatar() accepts as a 64×64 PNG: the signature and
 * an IHDR header carrying the dimensions. Storage does not decode images.
 */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // RGBA
  return bytes;
}

after(async () => {
  await disconnectPrisma();
});

describe("the service-role key", () => {
  it("is accepted by an admin-only endpoint of the project in SUPABASE_URL", async () => {
    // Read-only, one row. An anon key, or a key from another project, is
    // rejected here — which is exactly the misconfiguration to catch.
    const { error } = await getSupabaseAdmin().auth.admin.listUsers({ page: 1, perPage: 1 });
    assert.equal(error, null, `service-role request rejected: ${error?.message}`);
  });
});

describe("avatar storage round trip: app code → Supabase Storage → Postgres", () => {
  let bucketExists = false;

  before(async () => {
    bucketExists = await avatarBucketExists();
    // Leftovers from a crashed run — ours, by exact prefix and address.
    if (bucketExists) await removeFixtureAvatarObjects(CI_USER_002);
    await removeFixtureUser(CI_USER_002);
    await createFixtureUser(CI_USER_002);
  });

  after(async () => {
    if (bucketExists) await removeFixtureAvatarObjects(CI_USER_002);
    await removeFixtureUser(CI_USER_002);
  });

  it("uploads under the user's own prefix, records the URL, and removes it again", async (t) => {
    if (!bucketExists) {
      t.skip(`the test project has no "${AVATAR_BUCKET}" storage bucket — create it (public, as in production) to run this`);
      return;
    }

    const { avatarUrl } = await replaceAvatar(CI_USER_002.id, pngHeader(64, 64));
    assert.match(
      avatarUrl,
      new RegExp(`/${AVATAR_BUCKET}/${CI_USER_002.id}/[0-9a-f-]{36}\\.png$`),
      "the key must be derived server-side under the user's own prefix",
    );

    const row = await prisma.appUsers.findUnique({
      where: { id: CI_USER_002.id },
      select: { avatarUrl: true, avatarType: true },
    });
    assert.equal(row?.avatarUrl, avatarUrl);
    assert.equal(row?.avatarType, "upload");
    assert.equal((await listFixtureAvatarKeys(CI_USER_002)).length, 1, "exactly one stored object");

    const reset = await removeAvatar(CI_USER_002.id);
    assert.equal(reset.avatarUrl, DEFAULT_AVATAR_URL);
    assert.deepEqual(await listFixtureAvatarKeys(CI_USER_002), [], "the object must be deleted");
  });
});
