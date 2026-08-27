/**
 * The themes the app ships with, as opposed to the ones a reader imports.
 *
 * Kept in one place because five call sites used to spell the set out as a
 * chain of equality checks — the viewer, the title bar's menu, the settings
 * picker, the pre-paint script in `app.html`, and the Mermaid export — and a
 * fourth theme added to four of them is a theme that half the app does not
 * believe in.
 */
export const BUILT_IN_THEMES = ['system', 'light', 'dark', 'reading'] as const;

export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];

/** Anything else is `vscode:<name>`, an imported theme. */
export function isBuiltInTheme(theme: string): theme is BuiltInTheme {
	return (BUILT_IN_THEMES as readonly string[]).includes(theme);
}

/**
 * Whether a theme paints on a dark ground.
 *
 * `data-theme` names the palette; `data-theme-type` names only which end of the
 * range it sits at, and that is what the rest of the app asks — Monaco picks
 * `vs-dark` or `vs` from it, Mermaid picks a diagram palette, and the title bar
 * decides whether to invert an icon. A theme that is dark without being called
 * `dark` has to answer here, or every one of those reads it as light.
 *
 * `system` is deliberately absent: it has no answer of its own, and the caller
 * resolves it against the OS before asking.
 */
export function isDarkBuiltInTheme(theme: string): boolean {
	return theme === 'dark' || theme === 'reading';
}
