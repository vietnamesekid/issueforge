/**
 * Build an optional property without tripping `exactOptionalPropertyTypes`.
 *
 * That setting distinguishes two things TypeScript otherwise conflates:
 *
 *   {}                      the key is absent
 *   { token: undefined }    the key exists and holds undefined
 *
 * A field declared `token?: string` permits the first and rejects the second, so
 * assigning a possibly-undefined value directly is an error. The alternative written
 * inline — `...(x !== undefined ? { k: x } : {})` — is correct but noisy, and it
 * repeats at every call site.
 *
 * The distinction is worth keeping rather than switching the setting off. Two places
 * in this codebase depend on it: `RunPatch.ownership` uses `null` to mean "clear the
 * process group" and absence to mean "leave it alone", and a run's `exitCode` of 0 is
 * a real value that a truthiness check would silently drop. The second was an actual
 * bug, found by a test.
 */

/** Include `key` only when `value` is neither undefined nor null. */
export function optional<K extends string, V>(
  key: K,
  value: V | undefined | null,
): Record<K, V> | Record<string, never> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Include `key` only when `value` is defined.
 *
 * Distinct from `optional` because `null` is sometimes meaningful — see
 * `RunPatch.ownership`, where it is the instruction to clear a value rather than the
 * absence of one.
 */
export function optionalDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
