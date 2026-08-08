import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AvatarValidationError,
  MAX_AVATAR_BYTES,
  detectImageType,
  validateAvatar,
} from "../avatarStorage.service.js";

/**
 * Avatar upload is the one endpoint that accepts arbitrary bytes from the
 * internet, so validation is tested against what an attacker would actually
 * send: content that lies about what it is.
 *
 * Everything here checks the FILE'S OWN BYTES. The extension and the browser's
 * Content-Type are not evidence — both are set by the caller.
 */

/** Minimal but structurally valid headers for each accepted format. */
function pngHeader(width = 256, height = 256): Buffer {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegHeader(width = 256, height = 256): Buffer {
  const buf = Buffer.alloc(64);
  // SOI, then a SOF0 frame carrying the dimensions.
  Buffer.from([0xff, 0xd8, 0xff]).copy(buf, 0);
  buf[3] = 0xe0;
  buf.writeUInt16BE(16, 4); // segment length
  let o = 20;
  buf[o] = 0xff;
  buf[o + 1] = 0xc0;
  buf.writeUInt16BE(17, o + 2);
  buf[o + 4] = 8;
  buf.writeUInt16BE(height, o + 5);
  buf.writeUInt16BE(width, o + 7);
  return buf;
}

function webpHeader(): Buffer {
  const buf = Buffer.alloc(64);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(56, 4);
  buf.write("WEBP", 8, "ascii");
  return buf;
}

describe("format detection", () => {
  it("recognizes the three accepted formats", () => {
    assert.deepEqual(detectImageType(pngHeader()), { mime: "image/png", ext: "png" });
    assert.deepEqual(detectImageType(jpegHeader()), { mime: "image/jpeg", ext: "jpg" });
    assert.deepEqual(detectImageType(webpHeader()), { mime: "image/webp", ext: "webp" });
  });

  it("rejects an SVG, however it is labelled", () => {
    // SVG is a scriptable document and this service does not sanitize it.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    assert.equal(detectImageType(svg), null);
  });

  it("rejects text renamed to .png", () => {
    assert.equal(detectImageType(Buffer.from("this is definitely not an image")), null);
  });

  it("rejects an executable", () => {
    // "MZ" — a Windows PE header.
    assert.equal(detectImageType(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null);
  });

  it("rejects a GIF, which is not on the accepted list", () => {
    assert.equal(detectImageType(Buffer.from("GIF89a......")), null);
  });

  it("rejects an HTML page pretending to be an image", () => {
    assert.equal(detectImageType(Buffer.from("<!doctype html><script>alert(1)</script>")), null);
  });
});

describe("validateAvatar", () => {
  it("accepts a well-formed PNG", () => {
    assert.deepEqual(validateAvatar(pngHeader()), { mime: "image/png", ext: "png" });
  });

  it("accepts a well-formed JPEG", () => {
    assert.deepEqual(validateAvatar(jpegHeader()), { mime: "image/jpeg", ext: "jpg" });
  });

  it("refuses an empty file", () => {
    assert.throws(() => validateAvatar(Buffer.alloc(0)), AvatarValidationError);
  });

  it("refuses a file over the size ceiling", () => {
    const huge = Buffer.concat([pngHeader(), Buffer.alloc(MAX_AVATAR_BYTES + 1)]);
    assert.throws(
      () => validateAvatar(huge),
      (err: unknown) => {
        assert.ok(err instanceof AvatarValidationError);
        assert.match(err.message, /too large/i);
        return true;
      },
    );
  });

  it("refuses an image below the minimum useful size", () => {
    assert.throws(
      () => validateAvatar(pngHeader(32, 32)),
      (err: unknown) => {
        assert.ok(err instanceof AvatarValidationError);
        assert.match(err.message, /too small/i);
        return true;
      },
    );
  });

  it("measures a JPEG's dimensions from its frame header", () => {
    assert.throws(() => validateAvatar(jpegHeader(16, 16)), /too small/i);
    assert.doesNotThrow(() => validateAvatar(jpegHeader(128, 128)));
  });

  it("gives a message the user can act on, not an internal one", () => {
    try {
      validateAvatar(Buffer.from("nope"));
      assert.fail("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /JPEG, PNG or WebP/);
      // No stack detail, no library name, no path.
      assert.ok(!message.includes("Buffer"));
      assert.ok(!message.includes("supabase"));
    }
  });
});
