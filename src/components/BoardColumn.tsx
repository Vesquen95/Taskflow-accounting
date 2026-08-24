import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Column, Task } from '../types'
import { TaskCard } from './TaskCard'
import { EmptyState } from './EmptyState'

interface BoardColumnProps {
  column: Column
  tasks: Task[]
  allColumns: Column[]
  onOpenTask: (task: Task) => void
  onMoveTask: (taskId: string, columnId: string) => void
  onAddTask: () => void
  onRename: (name: string) => void
  onDelete: () => void
  canDelete: boolean
}

export function BoardColumn({
  column,
  tasks,
  allColumns,
  onOpenTask,
  onMoveTask,
  onAddTask,
  onRename,
  onDelete,
  canDelete,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' } })
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(column.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  function commitName() {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== column.name) {
      onRename(trimmed)
    } else {
      setNameDraft(column.name)
    }
    setEditingName(false)
  }

  return (
    <div className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-slate-100">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setNameDraft(column.name)
                setEditingName(false)
              }
            }}
            maxLength={200}
            aria-label="Kolomnaam"
            className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm font-semibold focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="min-w-0 flex-1 truncate rounded px-1 text-left text-sm font-semibold text-slate-700 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {column.name}{' '}
            <span className="font-normal text-slate-400">({tasks.length})</span>
          </button>
        )}

        {canDelete &&
          (confirmingDelete ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onDelete}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                Ja
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Nee
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label={`Verwijder kolom ${column.name}`}
              className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path
                  fillRule="evenodd"
                  d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          ))}
      </div>

      <div
        ref={setNodeRef}
        className={`flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto p-3 transition ${
          isOver ? 'bg-brand-50' : ''
        }`}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <EmptyState title="Geen taken" description="Sleep een taak hierheen of voeg er een toe." />
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                columns={allColumns}
                onOpen={() => onOpenTask(task)}
                onMoveTo={(columnId) => onMoveTask(task.id, columnId)}
              />
            ))
          )}
        </SortableContext>
      </div>

      <div className="p-3 pt-0">
        <button
          type="button"
          onClick={onAddTask}
          className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-sm font-medium text-slate-500 hover:border-brand-400 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          + Taak toevoegen
        </button>
      </div>
    </div>
  )
}
