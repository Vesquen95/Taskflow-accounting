import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Column, Task } from '../types'
import { LabelBadge } from './LabelBadge'
import { dueStatusClasses, dueStatusLabel, formatDueDate, getDueStatus } from '../lib/dueDate'

interface TaskCardProps {
  task: Task
  columns: Column[]
  onOpen: () => void
  onMoveTo: (columnId: string) => void
}

export function TaskCard({ task, columns, onOpen, onMoveTo }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', columnId: task.column_id },
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const dueStatus = getDueStatus(task.due_date)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group rounded-md border border-slate-200 bg-white p-3 shadow-sm transition hover:shadow-md focus-within:ring-2 focus-within:ring-brand-500 ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Sleep taak "${task.title}" om te verplaatsen`}
          className="mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-slate-300 hover:text-slate-500 active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M7 4a1 1 0 100 2 1 1 0 000-2zm0 5a1 1 0 100 2 1 1 0 000-2zm0 5a1 1 0 100 2 1 1 0 000-2zm6-10a1 1 0 100 2 1 1 0 000-2zm0 5a1 1 0 100 2 1 1 0 000-2zm0 5a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left focus:outline-none"
        >
          <p className="break-words text-sm font-medium text-slate-800">{task.title}</p>
          {task.description && (
            <p className="mt-0.5 line-clamp-2 break-words text-xs text-slate-500">{task.description}</p>
          )}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
        {dueStatus && (
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${dueStatusClasses[dueStatus]}`}
          >
            {dueStatusLabel[dueStatus]} · {formatDueDate(task.due_date)}
          </span>
        )}
        {task.labels.map((label) => (
          <LabelBadge key={label.id} label={label} />
        ))}
      </div>

      <div className="mt-2 pl-6">
        <label className="sr-only" htmlFor={`move-${task.id}`}>
          Verplaats &ldquo;{task.title}&rdquo; naar kolom
        </label>
        <select
          id={`move-${task.id}`}
          value={task.column_id}
          onChange={(e) => onMoveTo(e.target.value)}
          className="rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] text-slate-600 focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              Verplaats naar: {c.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
