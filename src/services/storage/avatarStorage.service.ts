import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { prisma } from "../../lib/prisma.js";
import { DEFAULT_AVATAR_URL } from "../../config/branding.js";

/**
 * Profile photo storage, backed by Supabase Storage.
 *
 * THE IMAGE NEVER TOUCHES THE DATABASE. Only a URL is stored on the user row.
 * Base64 in a column bloats every query that selects the user, breaks caching,
 * and turns a 2 MB upload into a 2.7 MB text field read on every session check.
 *
 * The storage key is derived server-side from the SESSION's user id and a fresh
 * UUID. Nothing from the client reaches the path — not the filename, not an id,
 * not the extension — so there is no shape of request that writes into another
 * user's folder or escapes the bucket with `../`.
 */

export const AVATAR_BUCKET = "avatars";
export const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3 MB

/**
 * Formats we accept, keyed by their magic bytes.
 *
 * The signature is checked, NOT the extension and NOT the browser's
 * Content-Type — both are attacker-controlled. SVG is deliberately absent: it
 * is a script-bearing document, and we do not sanitize it.
 */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  {
    mime: "image/jpeg",
    ext: "jpg",
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    ext: "png",
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: "image/webp",
    ext: "webp",
    // "RIFF" .... "WEBP"
    test: (b) =>
      b.length > 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
];

export class AvatarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarValidationError";
  }
}

/** The real format of these bytes, or null when it is not one we accept. */
export function detectImageType(buffer: Buffer): { mime: string; ext: string } | null {
  const match = SIGNATURES.find((s) => s.test(buffer));
  return match ? { mime: match.mime, ext: match.ext } : null;
}

/**
 * Minimum useful dimensions, read from the file's own header.
 *
 * Only PNG and JPEG are measured — WebP's several sub-formats make a
 * hand-rolled reader more likely to reject a valid file than to catch a bad
 * one, so a WebP passes on its signature alone.
 */
function readDimensions(buffer: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === "png") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (ext === "jpg") {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        // SOF0..SOF15, excluding the non-frame markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

const MIN_DIMENSION = 64;

/**
 * Validate the uploaded bytes. Throws AvatarValidationError with a message the
 * user can act on.
 */
export function validateAvatar(buffer: Buffer): { mime: string; ext: string } {
  if (buffer.length === 0) throw new AvatarValidationError("The file is empty.");
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new AvatarValidationError(
      `That image is too large. The maximum is ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const type = detectImageType(buffer);
  if (!type) {
    throw new AvatarValidationError(
      "That file is not a supported image. Use a JPEG, PNG or WebP.",
    );
  }

  const dimensions = readDimensions(buffer, type.ext);
  if (dimensions && (dimensions.width < MIN_DIMENSION || dimensions.height < MIN_DIMENSION)) {
    throw new AvatarValidationError(
      `That image is too small. It must be at least ${MIN_DIMENSION}×${MIN_DIMENSION} pixels.`,
    );
  }

  return type;
}

/** `avatars/{userId}/{uuid}.{ext}` — every component generated server-side. */
function storageKey(userId: string, ext: string): string {
  return `${userId}/${randomUUID()}.${ext}`;
}

/**
 * The stored key for a URL this service produced, or null when it is not one.
 *
 * The shared default frog lives at a LOCAL path that also contains `/avatars/`
 * (`/avatars/default-frog.svg`), so it is excluded first. Without that, every
 * first upload would reach the ownership check and log a refusal for what is
 * simply the normal case — noise that would eventually hide a real one.
 */
function keyFromPublicUrl(url: string | null): string | null {
  if (!url) return null;
  // A stored object is always an absolute URL; the default asset never is.
  if (!/^https?:\/\//i.test(url)) return null;

  const marker = `/${AVATAR_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const key = url.slice(index + marker.length).split("?")[0];
  // Belt and braces: never act on a path that tries to climb out.
  return key.includes("..") ? null : key;
}

/**
 * Store a new avatar and point the user row at it.
 *
 * The previous custom object is deleted afterwards, and ONLY when its key sits
 * under this user's own prefix — a stray URL must never let one account delete
 * another's file. A failed cleanup leaves an orphan, which is a storage cost,
 * not a correctness problem.
 */
export async function replaceAvatar(
  userId: string,
  buffer: Buffer,
): Promise<{ avatarUrl: string }> {
  const { mime, ext } = validateAvatar(buffer);

  const current = await prisma.appUsers.findUnique({
    where: { id: userId },
    select: { avatarUrl: true },
  });

  const key = storageKey(userId, ext);
  const { error } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .upload(key, buffer, { contentType: mime, upsert: false });

  if (error) {
    throw new Error(`Avatar upload failed: ${error.message}`);
  }

  const { data } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(key);
  const avatarUrl = data.publicUrl;

  await prisma.appUsers.update({
    where: { id: userId },
    data: { avatarUrl, avatarType: "upload", updatedAt: new Date() },
  });

  await deletePreviousObject(userId, current?.avatarUrl ?? null);
  return { avatarUrl };
}

/** Reset to the shared default frog and remove the user's own object. */
export async function removeAvatar(userId: string): Promise<{ avatarUrl: string }> {
  const current = await prisma.appUsers.findUnique({
    where: { id: userId },
    select: { avatarUrl: true },
  });

  await prisma.appUsers.update({
    where: { id: userId },
    data: { avatarUrl: DEFAULT_AVATAR_URL, avatarType: "default", updatedAt: new Date() },
  });

  await deletePreviousObject(userId, current?.avatarUrl ?? null);
  return { avatarUrl: DEFAULT_AVATAR_URL };
}

/**
 * Delete a previously stored object, if and only if it belongs to this user.
 *
 * The ownership check is the point. The shared default frog is a static asset
 * with no key here, so it can never be selected; and a key outside the user's
 * own prefix is refused rather than deleted.
 */
async function deletePreviousObject(userId: string, previousUrl: string | null): Promise<void> {
  const key = keyFromPublicUrl(previousUrl);
  if (!key) return;
  if (!key.startsWith(`${userId}/`)) {
    console.warn("[avatar] refusing to delete an object outside the user's own prefix");
    return;
  }
  const { error } = await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([key]);
  if (error) {
    // An orphan costs storage; failing the request would cost the user their
    // new avatar for no benefit.
    console.warn(`[avatar] could not delete the previous object: ${error.message}`);
  }
}
