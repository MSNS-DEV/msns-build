/**
 * Which R2 object keys may be served/modified by which callers.
 *
 * The bucket is shared with the public website and holds private files
 * (staff CVs, student photos, documents), so every route that takes a key
 * from the URL or request body must go through these checks.
 */

/** Served to anyone, including the public website and logged-out visitors. */
export const PUBLIC_PREFIXES = [
  "gallery/",
  "videos/",
  "logos/",
  "placeholders/",
  "social/",
] as const;

/** Keys the gallery management routes may read, move, copy, rename or delete. */
export const GALLERY_PREFIXES = ["gallery/", "videos/"] as const;

/** Rejects traversal, absolute paths, backslashes and empty segments. */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.startsWith("/") || key.includes("\\")) return false;
  const segments = key.split("/");
  // A trailing "/" (folder key) leaves one empty last segment; allow only that.
  return segments.every(
    (s, i) =>
      s !== ".." && s !== "." && (s !== "" || i === segments.length - 1),
  );
}

export const isPublicKey = (key: string) =>
  isSafeKey(key) && PUBLIC_PREFIXES.some((p) => key.startsWith(p));

export const isGalleryKey = (key: string) =>
  isSafeKey(key) && GALLERY_PREFIXES.some((p) => key.startsWith(p));

/** Cache policy: public assets are immutable, private files are never cached. */
export const cacheControlFor = (key: string) =>
  isPublicKey(key)
    ? "public, max-age=31536000, immutable"
    : "private, no-store";
