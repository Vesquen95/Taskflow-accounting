import { useState, type FormEvent } from 'react'
import { Modal } from './Modal'
import type { Employee } from '../types'
import { reportError } from '../lib/errorMessage'

export function AdhocTaskFormModal({
  employees,
  defaultAssigneeId,
  onClose,
  onSubmit,
}: {
  employees: Employee[]
  defaultAssigneeId: string | null
  onClose: () => void
  onSubmit: (input: { title: string; description: string | null; due_date: string; toegewezen_medewerker_id: string }) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10))
  const [assignee, setAssignee] = useState(defaultAssigneeId ?? employees[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('Titel is verplicht.')
      return
    }
    if (!assignee) {
      setError('Kies een verantwoordelijke.')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit({ title: title.trim(), description: description.trim() || null, due_date: dueDate, toegewezen_medewerker_id: assignee })
      onClose()
    } catch (err) {
      setError(reportError(err, 'Aanmaken is mislukt'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="Ad-hoc taak aanmaken" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3 text-sm">
        <div>
          <label htmlFor="adhoc-title" className="mb-1 block text-xs font-medium text-slate-500">Titel *</label>
          <input id="adhoc-title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5" required />
        </div>
        <div>
          <label htmlFor="adhoc-description" className="mb-1 block text-xs font-medium text-slate-500">Omschrijving</label>
          <textarea id="adhoc-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-md border border-slate-300 px-2 py-1.5" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="adhoc-due-date" className="mb-1 block text-xs font-medium text-slate-500">Deadline</label>
            <input id="adhoc-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5" />
          </div>
          <div>
            <label htmlFor="adhoc-assignee" className="mb-1 block text-xs font-medium text-slate-500">Verantwoordelijke</label>
            <select id="adhoc-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5">
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.naam}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Ad-hoc taken volgen geen recurrence en vereisen nooit goedkeuring — voor eenmalig, niet-wettelijk werk bij deze klant.
        </p>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100">
            Annuleren
          </button>
          <button type="submit" disabled={submitting} className="rounded-md bg-brand-600 px-4 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {submitting ? 'Bezig…' : 'Aanmaken'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
