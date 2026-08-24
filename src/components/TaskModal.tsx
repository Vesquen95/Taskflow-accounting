import { useState } from 'react'
import type { Column, Label, Task } from '../types'
import { Modal } from './Modal'

interface TaskModalProps {
  mode: 'create' | 'edit'
  task?: Task
  columns: Column[]
  labels: Label[]
  defaultColumnId: string
  onClose: () => void
  onCreate: (input: {
    columnId: string
    title: string
    description?: string | null
    dueDate?: string | null
    labelIds?: string[]
  }) => Promise<void>
  onUpdate: (
    taskId: string,
    updates: { title?: string; description?: string | null; dueDate?: string | null; labelIds?: string[] }
  ) => Promise<void>
  onDelete?: (taskId: string) => Promise<void>
  onMove?: (taskId: string, columnId: string) => Promise<void>
}

export function TaskModal({
  mode,
  task,
  columns,
  labels,
  defaultColumnId,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onMove,
}: TaskModalProps) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [dueDate, setDueDate] = useState(task?.due_date ?? '')
  const [columnId, setColumnId] = useState(task?.column_id ?? defaultColumnId)
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>(task?.labels.map((l) => l.id) ?? [])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  function toggleLabel(id: string) {
    setSelectedLabelIds((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]))
  }

  async function handleSubmit() {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('Titel is verplicht.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'create') {
        await onCreate({
          columnId,
          title: trimmedTitle,
          description: description.trim() || null,
          dueDate: dueDate || null,
          labelIds: selectedLabelIds,
        })
      } else if (task) {
        if (columnId !== task.column_id && onMove) {
          await onMove(task.id, columnId)
        }
        await onUpdate(task.id, {
          title: trimmedTitle,
          description: description.trim() || null,
          dueDate: dueDate || null,
          labelIds: selectedLabelIds,
        })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan mislukt. Probeer het opnieuw.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!task || !onDelete) return
    setSubmitting(true)
    setError(null)
    try {
      await onDelete(task.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verwijderen mislukt. Probeer het opnieuw.')
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={mode === 'create' ? 'Nieuwe taak' : 'Taak bewerken'}
      onClose={onClose}
      footer={
        <>
          {mode === 'edit' && onDelete && (
            <div className="mr-auto">
              {confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-600">Weet je het zeker?</span>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={submitting}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                  >
                    Ja, verwijderen
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    Annuleren
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  Verwijderen
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Annuleren
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
          >
            {submitting ? 'Bezig…' : mode === 'create' ? 'Aanmaken' : 'Opslaan'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div>
          <label htmlFor="task-title" className="mb-1 block text-sm font-medium text-slate-700">
            Titel <span className="text-red-500">*</span>
          </label>
          <input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>

        <div>
          <label htmlFor="task-description" className="mb-1 block text-sm font-medium text-slate-700">
            Beschrijving
          </label>
          <textarea
            id="task-description"
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={5000}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="task-column" className="mb-1 block text-sm font-medium text-slate-700">
              Kolom
            </label>
            <select
              id="task-column"
              value={columnId}
              onChange={(e) => setColumnId(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="task-due" className="mb-1 block text-sm font-medium text-slate-700">
              Deadline
            </label>
            <div className="flex gap-1">
              <input
                id="task-due"
                type="date"
                value={dueDate ?? ''}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              {dueDate && (
                <button
                  type="button"
                  onClick={() => setDueDate('')}
                  aria-label="Deadline wissen"
                  className="rounded-md border border-slate-300 px-2 text-xs text-slate-500 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        </div>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">Labels</legend>
          {labels.length === 0 ? (
            <p className="text-xs text-slate-400">
              Nog geen labels. Maak er een aan via &ldquo;Labels beheren&rdquo;.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {labels.map((label) => {
                const checked = selectedLabelIds.includes(label.id)
                return (
                  <label
                    key={label.id}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      checked ? '' : 'opacity-60'
                    }`}
                    style={{
                      backgroundColor: `${label.color}22`,
                      color: label.color,
                      borderColor: `${label.color}66`,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleLabel(label.id)}
                      className="h-3 w-3"
                    />
                    {label.name}
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>
      </div>
    </Modal>
  )
}
