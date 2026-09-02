import { useState, type FormEvent } from 'react'
import { Modal } from './Modal'
import type { Employee } from '../types'
import { reportError } from '../lib/errorMessage'
import {
  buitenlandseBtwDeadline,
  buitenlandseBtwJaren,
  buitenlandseBtwTitel,
} from '../lib/taakLabel'

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
  const [teruggaafJaar, setTeruggaafJaar] = useState(() => buitenlandseBtwJaren()[1])

  /** Vult titel en deadline in; de rest van het formulier blijft gewoon
   *  bewerkbaar. Een sneltoets die meteen zou opslaan, neemt je de kans af om
   *  er nog een verantwoordelijke of een notitie bij te zetten. */
  function vulTeruggaafIn() {
    setTitle(buitenlandseBtwTitel(teruggaafJaar))
    setDueDate(buitenlandseBtwDeadline(teruggaafJaar))
  }

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
        {/* De teruggaaf van buitenlandse btw is geen terugkerende verplichting
            -- niet elke klant heeft er een, en meestal weet je het pas als de
            facturen er zijn. De termijn is wél vast, en die telkens opnieuw
            uitrekenen is precies waar het misgaat: de btw van 2025 vraag je
            terug tegen 30 september 2026. */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
          <div>
            <label htmlFor="adhoc-teruggaafjaar" className="mb-1 block text-xs font-medium text-slate-500">
              Teruggaaf buitenlandse btw over
            </label>
            <select
              id="adhoc-teruggaafjaar"
              value={teruggaafJaar}
              onChange={(e) => setTeruggaafJaar(Number(e.target.value))}
              className="rounded-md border border-slate-300 px-2 py-1.5"
            >
              {buitenlandseBtwJaren().map((jaar) => (
                <option key={jaar} value={jaar}>
                  {jaar}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={vulTeruggaafIn}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Invullen
          </button>
          <p className="w-full text-xs text-slate-500">
            Zet de titel en de deadline klaar: indienen tegen{' '}
            {buitenlandseBtwDeadline(teruggaafJaar).split('-').reverse().join('/')}.
          </p>
        </div>
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
