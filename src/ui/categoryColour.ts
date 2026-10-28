/**
 * Category colours. A category stores a token, `cat-1` … `cat-12`; databases
 * from before the twelve colours may still hold `chart-1` … `chart-6`, which
 * map to the same-numbered `cat-N`. The colour itself is a CSS variable in
 * `styles.css`, so it follows the theme without a re-render.
 */

export const CATEGORY_COLOURS = 12;

/** Every colour a category can take, in the order new categories get them. */
export const CATEGORY_TOKENS: string[] = Array.from({ length: CATEGORY_COLOURS }, (_, i) => `cat-${i + 1}`);

/** The `cat-N` token a stored colour stands for. Anything unreadable is `cat-1`. */
export function categoryToken(token: string | null | undefined): string {
  const match = /^(?:cat|chart)-(\d+)$/.exec(token ?? "");
  const n = match ? Number(match[1]) : 0;
  return n >= 1 ? `cat-${((n - 1) % CATEGORY_COLOURS) + 1}` : "cat-1";
}

/** The category's colour as a CSS value: `var(--cat-N)`. */
export function categoryColour(token: string | null | undefined): string {
  return `var(--${categoryToken(token)})`;
}
