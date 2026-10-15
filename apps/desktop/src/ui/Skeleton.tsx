// Quiet loading placeholders. A shimmer by default; a still block when the
// reader prefers reduced motion (handled in skeleton.css).

export type SkeletonVariant = 'text' | 'row' | 'pill'

/**
 * A block of loading placeholders.
 *
 * - `variant="text"` (default): stacked lines the height of body text.
 * - `variant="row"`: list-row blocks, for a menu or list of items.
 * - `variant="pill"`: one control-sized pill, for a button that has not resolved.
 *
 * Decorative: the surrounding region owns the accessible status text.
 */
export function Skeleton({ lines = 1, variant = 'text', className }: { lines?: number; variant?: SkeletonVariant; className?: string }) {
  const count = Number.isFinite(lines) ? Math.max(1, Math.min(24, Math.floor(lines))) : 1
  return <div className={`skeleton skeleton-${variant}${className ? ` ${className}` : ''}`} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <span key={index} className="skeleton-block" />)}
  </div>
}
