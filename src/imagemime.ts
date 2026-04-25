/**
 * Detect an image's media type from its leading magic bytes.
 *
 * The Anthropic API rejects image content blocks whose declared media_type
 * doesn't match the bytes — we used to hardcode "image/jpeg" for everything,
 * which 400'd as soon as cua-driver started writing PNG (its `screenshot
 * --image-out` path always emits PNG bytes regardless of the chosen file
 * extension). Sniff per-file instead of trusting filenames.
 *
 * Recognized signatures:
 *   PNG  — 89 50 4E 47 0D 0A 1A 0A
 *   JPEG — FF D8 FF
 *
 * Anything else throws — better than lying to the API and getting a
 * less-useful 400 back.
 */
export type DetectedImageMime = "image/png" | "image/jpeg";

const PNG_MAGIC = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff]);

export function detectImageMimeType(bytes: Uint8Array): DetectedImageMime {
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  const head = Array.from(bytes.subarray(0, Math.min(bytes.length, 8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  throw new Error(
    `unrecognized image format (first ${Math.min(bytes.length, 8)} bytes: ${head}). Expected PNG or JPEG.`,
  );
}

function startsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[i] !== needle[i]) return false;
  }
  return true;
}
