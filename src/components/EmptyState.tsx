interface EmptyStateProps {
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 p-6 text-center">
      <p className="text-sm font-medium text-slate-500">{title}</p>
      {description && <p className="text-xs text-slate-400">{description}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 text-xs font-medium text-brand-600 hover:text-brand-700 focus:outline-none focus-visible:underline"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
