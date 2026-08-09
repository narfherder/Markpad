/**
 * Builds a CSS `font-family` value from a chosen family name and a fallback.
 *
 * The name has to be quoted. Unquoted, a family name is a sequence of CSS
 * identifiers, and the sequence is invalid when the first identifier is a
 * generic family keyword: `font-family: Serif Text, sans-serif` reads as the
 * generic `serif` followed by a stray `Text`, so the declaration is discarded
 * whole and the element goes on inheriting whatever it had. Choosing such a
 * font looked like it did nothing — the setting changed, the page did not.
 * It affects every family whose first word is `serif`, `sans-serif`, `mono`,
 * `monospace`, `cursive`, `fantasy`, `system-ui`, `math` or `emoji`.
 *
 * A quoted name is a string, which no keyword can be mistaken for.
 */
export function cssFontFamily(name: unknown, fallback: string): string {
	const family = typeof name === 'string' ? name.trim() : '';
	if (!family) return fallback;
	// The list comes from the system font enumeration rather than from user
	// input, but it still reaches a `style=` attribute: escape anything that
	// could close the string and open a declaration of its own.
	return `"${family.replace(/["\\]/g, '\\$&')}", ${fallback}`;
}
