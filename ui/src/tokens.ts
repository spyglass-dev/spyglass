/**
 * The CSS-variable token layer — every color the widgets paint, in one place.
 *
 * Each token is a `var(--rpt-*, fallback)` reference: hosts restyle the whole
 * widget set by defining the custom properties on any ancestor (no CSS file to
 * import, no Tailwind required); with nothing defined, the fallbacks render
 * the stock light theme.
 */
export const tokens = {
  /** Widget surface background. */
  bg: 'var(--rpt-bg, #fff)',
  /** Muted surface — table headers, total rows. */
  muted: 'var(--rpt-muted, #f9fafb)',
  /** Hairline borders. */
  border: 'var(--rpt-border, #e5e7eb)',
  /** Primary body text. */
  text: 'var(--rpt-text, #374151)',
  /** Secondary text — labels, captions, table headers. */
  textMuted: 'var(--rpt-text-muted, #6b7280)',
  /** Faint text — placeholders, absent states, truncation notices. */
  textFaint: 'var(--rpt-text-faint, #9ca3af)',
  /** Accent — interactive affordances, active sort, in-cell bars. */
  accent: 'var(--rpt-accent, #3b82f6)',
  /** Soft accent wash — in-cell bar fill, hover states. */
  accentSoft: 'var(--rpt-accent-soft, rgba(59, 130, 246, 0.14))',
  /** Positive delta / trend-up. */
  positive: 'var(--rpt-positive, #059669)',
  /** Negative delta / trend-down. */
  negative: 'var(--rpt-negative, #e11d48)',
} as const

export type Tokens = typeof tokens
