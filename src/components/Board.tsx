import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useAuth } from '../hooks/useAuth'
import { useBoardData } from '../hooks/useBoardData'
import type { Task } from '../types'
import { BoardColumn } from './BoardColumn'
import { TaskCard } from './TaskCard'
import { TaskModal } from './TaskModal'
import { LabelManager } from './LabelManager'
import { BoardSkeleton } from './Skeletons'
import { ErrorState } from './ErrorState'
import { EmptyState } from './EmptyState'

type TaskModalState = { mode: 'create'; columnId: string } | { mode: 'edit'; task: Task } | null

export function Board() {
  const { user, signOut } = useAuth()
  const {
    board,
    columns,
    tasks,
    labels,
    loading,
    error,
    reload,
    addColumn,
    renameColumn,
    deleteColumn,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    createLabel,
    updateLabel,
    deleteLabel,
  } = useBoardData()

  const [taskModal, setTaskModal] = useState<TaskModalState>(null)
  const [labelManagerOpen, setLabelManagerOpen] = useState(false)
  const [addingColumn, setAddingColumn] = useState(false)
  const [newColumnName, setNewColumnName] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const column of columns) {
      map.set(
        column.id,
        tasks.filter((t) => t.column_id === column.id).sort((a, b) => a.position - b.position)
      )
    }
    return map
  }, [columns, tasks])

  function findColumnName(id: string) {
    return columns.find((c) => c.id === id)?.name ?? ''
  }

  async function handleMoveTask(taskId: string, toColumnId: string, toIndex?: number) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    const destTasks = tasksByColumn.get(toColumnId) ?? []
    const index = toIndex ?? destTasks.length
    setActionError(null)
    try {
      await moveTask(taskId, toColumnId, index)
      setAnnouncement(`"${task.title}" verplaatst naar ${findColumnName(toColumnId)}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Verplaatsen mislukt.')
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const task = tasks.find((t) => t.id === event.active.id)
    setActiveTask(task ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveTask(null)
    if (!over) return

    const activeTaskItem = tasks.find((t) => t.id === active.id)
    if (!activeTaskItem) return

    const overIsColumn = columns.some((c) => c.id === over.id)
    const overIsTask = tasks.some((t) => t.id === over.id)

    let toColumnId: string
    let toIndex: number

    if (overIsColumn) {
      toColumnId = String(over.id)
      toIndex = (tasksByColumn.get(toColumnId) ?? []).length
    } else if (overIsTask) {
      const overTask = tasks.find((t) => t.id === over.id)!
      toColumnId = overTask.column_id
      const destTasks = tasksByColumn.get(toColumnId) ?? []
      toIndex = destTasks.findIndex((t) => t.id === overTask.id)
      if (toIndex < 0) toIndex = destTasks.length
    } else {
      return
    }

    if (toColumnId === activeTaskItem.column_id) {
      const destTasks = tasksByColumn.get(toColumnId) ?? []
      const fromIndex = destTasks.findIndex((t) => t.id === activeTaskItem.id)
      if (fromIndex === toIndex) return
    }

    void handleMoveTask(activeTaskItem.id, toColumnId, toIndex)
  }

  async function handleAddColumn() {
    const name = newColumnName.trim()
    if (!name) return
    setActionError(null)
    try {
      await addColumn(name)
      setNewColumnName('')
      setAddingColumn(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Kolom toevoegen mislukt.')
    }
  }

  async function handleDeleteColumn(columnId: string) {
    setActionError(null)
    try {
      await deleteColumn(columnId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Kolom verwijderen mislukt.')
    }
  }

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">
            T
          </div>
          <h1 className="text-base font-semibold text-slate-900">
            {board?.name ?? 'Taskflow'}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-slate-500 sm:inline">{user?.email}</span>
          <button
            type="button"
            onClick={() => setLabelManagerOpen(true)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Labels beheren
          </button>
          <button
            type="button"
            onClick={() => signOut()}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Uitloggen
          </button>
        </div>
      </header>

      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>

      {actionError && (
        <div className="px-4 pt-3 sm:px-6">
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </p>
        </div>
      )}

      <main className="flex-1 overflow-hidden">
        {loading ? (
          <BoardSkeleton />
        ) : error ? (
          <div className="p-6">
            <ErrorState message={error} onRetry={reload} />
          </div>
        ) : columns.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="Nog geen kolommen"
              description="Maak je eerste kolom aan om taken te kunnen beheren."
              action={{ label: '+ Kolom toevoegen', onClick: () => setAddingColumn(true) }}
            />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex h-full gap-4 overflow-x-auto p-4 sm:p-6">
              {columns.map((column) => (
                <BoardColumn
                  key={column.id}
                  column={column}
                  tasks={tasksByColumn.get(column.id) ?? []}
                  allColumns={columns}
                  onOpenTask={(task) => setTaskModal({ mode: 'edit', task })}
                  onMoveTask={(taskId, columnId) => handleMoveTask(taskId, columnId)}
                  onAddTask={() => setTaskModal({ mode: 'create', columnId: column.id })}
                  onRename={(name) => renameColumn(column.id, name)}
                  onDelete={() => handleDeleteColumn(column.id)}
                  canDelete={columns.length > 1}
                />
              ))}

              <div className="w-72 shrink-0">
                {addingColumn ? (
                  <div className="rounded-lg bg-slate-100 p-3">
                    <input
                      autoFocus
                      value={newColumnName}
                      onChange={(e) => setNewColumnName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddColumn()
                        if (e.key === 'Escape') setAddingColumn(false)
                      }}
                      placeholder="Kolomnaam"
                      aria-label="Naam van nieuwe kolom"
                      className="mb-2 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleAddColumn}
                        className="flex-1 rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        Toevoegen
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAddingColumn(false)
                          setNewColumnName('')
                        }}
                        className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        Annuleren
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingColumn(true)}
                    className="h-12 w-full rounded-lg border-2 border-dashed border-slate-300 text-sm font-medium text-slate-500 hover:border-brand-400 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    + Kolom toevoegen
                  </button>
                )}
              </div>
            </div>

            <DragOverlay>
              {activeTask ? (
                <div className="w-72 rotate-2 opacity-90">
                  <TaskCard task={activeTask} columns={columns} onOpen={() => {}} onMoveTo={() => {}} />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      {taskModal && (
        <TaskModal
          mode={taskModal.mode}
          task={taskModal.mode === 'edit' ? taskModal.task : undefined}
          columns={columns}
          labels={labels}
          defaultColumnId={taskModal.mode === 'create' ? taskModal.columnId : columns[0]?.id ?? ''}
          onClose={() => setTaskModal(null)}
          onCreate={createTask}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onMove={(taskId, columnId) => handleMoveTask(taskId, columnId)}
        />
      )}

      {labelManagerOpen && (
        <LabelManager
          labels={labels}
          onClose={() => setLabelManagerOpen(false)}
          onCreate={createLabel}
          onUpdate={updateLabel}
          onDelete={deleteLabel}
        />
      )}
    </div>
  )
}
