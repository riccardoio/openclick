import { describe, expect, test } from "bun:test";
import { detectImageMimeType } from "../src/imagemime.ts";

describe("detectImageMimeType", () => {
  test("PNG magic bytes → image/png", () => {
    // Full PNG header (8-byte signature) + a few trailing zeros to simulate a
    // real file. cua-driver's screenshot output starts with exactly this.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    expect(detectImageMimeType(png)).toBe("image/png");
  });

  test("JPEG magic bytes → image/jpeg", () => {
    // SOI + APP0 marker — matches the 1x1 fixture JPEG used elsewhere in tests.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(detectImageMimeType(jpeg)).toBe("image/jpeg");
  });

  test("unrecognized magic bytes throw with a helpful hex preview", () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(() => detectImageMimeType(garbage)).toThrow(/unrecognized/);
    expect(() => detectImageMimeType(garbage)).toThrow(/00 01 02 03 04 05/);
  });

  test("too-short buffer (smaller than PNG signature) still throws cleanly", () => {
    // Two bytes that match JPEG's prefix but are not enough to fully match.
    const tiny = Buffer.from([0xff, 0xd8]);
    expect(() => detectImageMimeType(tiny)).toThrow(/unrecognized/);
  });

  test("empty buffer throws", () => {
    expect(() => detectImageMimeType(Buffer.alloc(0))).toThrow(/unrecognized/);
  });
});
