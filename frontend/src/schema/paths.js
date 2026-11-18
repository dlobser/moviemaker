// Path identity for the v2 document.
//
// A v1 project joins everything on path strings, and the same file can be
// spelled three ways in one file: `assets/x.png`, `assets\x.png` and, on a
// Windows checkout, `Assets/X.PNG`. The migration folds those into one media
// record, so it needs one rule for "the same path" that the selectors can
// apply too. That rule lives here and nowhere else.
//
// URLs (`https://…`, `asset://…`) are references to things that never lived in
// `assets/`; they are kept byte for byte because a signed URL or an Atlas
// asset id may well be case-sensitive.

export const EXTERNAL_PATTERN = /^(https?|asset):\/\//i;

/** True for a value that points outside the project folder. */
export function isExternalPath(value) {
  return typeof value === 'string' && EXTERNAL_PATTERN.test(value.trim());
}

/** Forward slashes only, trimmed; URLs untouched; '' for anything that is not a path. */
export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (isExternalPath(text)) return text;
  return text.split('\\').join('/');
}

/**
 * The identity key of a path: separator- and case-insensitive for local
 * paths (invariant §4.9.3), exact for URLs.
 */
export function pathKey(value) {
  const normalized = normalizePath(value);
  if (!normalized) return '';
  return isExternalPath(normalized) ? normalized : normalized.toLowerCase();
}
