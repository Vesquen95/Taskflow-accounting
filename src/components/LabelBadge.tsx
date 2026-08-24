import type { Label } from '../types'

export function LabelBadge({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${label.color}22`, color: label.color, border: `1px solid ${label.color}55` }}
    >
      {label.name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Verwijder label ${label.name}`}
          className="rounded-full leading-none hover:opacity-70 focus:outline-none focus-visible:ring-1 focus-visible:ring-current"
        >
          ×
        </button>
      )}
    </span>
  )
}
