import { useState } from 'react'
import type { Label } from '../types'
import { Modal } from './Modal'

const COLOR_SWATCHES = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
]

function EditableLabelRow({
  label,
  busy,
  onRename,
  onDelete,
}: {
  label: Label
  busy: boolean
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(label.name)

  function commit() {
    const trimmed = name.trim()
    if (trimmed && trimmed !== label.name) {
      onRename(trimmed)
    } else {
      setName(label.name)
    }
  }

  return (
    <li className="flex items-center gap-2">
      <span
        className="h-4 w-4 shrink-0 rounded-full border border-black/10"
        style={{ backgroundColor: label.color }}
        aria-hidden="true"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label={`Naam van label ${label.name}`}
        className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      />
      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        aria-label={`Verwijder label ${label.name}`}
        className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
      >
        Verwijderen
      </button>
    </li>
  )
}

interface LabelManagerProps {
  labels: Label[]
  onClose: () => void
  onCreate: (name: string, color: string) => Promise<void>
  onUpdate: (id: string, updates: { name?: string; color?: string }) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

export function LabelManager({ labels, onClose, onCreate, onUpdate, onDelete }: LabelManagerProps) {
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(COLOR_SWATCHES[5])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    if (!newName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(newName.trim(), newColor)
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Label aanmaken mislukt.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    setError(null)
    try {
      await onDelete(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Label verwijderen mislukt.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Labels beheren" onClose={onClose}>
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <ul className="space-y-2">
          {labels.length === 0 && (
            <li className="text-sm text-slate-400">Nog geen labels op dit bord.</li>
          )}
          {labels.map((label) => (
            <EditableLabelRow
              key={label.id}
              label={label}
              busy={busy}
              onRename={(name) => onUpdate(label.id, { name })}
              onDelete={() => handleDelete(label.id)}
            />
          ))}
        </ul>

        <div className="border-t border-slate-200 pt-4">
          <p className="mb-2 text-sm font-medium text-slate-700">Nieuw label</p>
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Naam"
              aria-label="Naam van nieuw label"
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            <button
              type="button"
              disabled={busy || !newName.trim()}
              onClick={handleCreate}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
            >
              Toevoegen
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Kies een kleur">
            {COLOR_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setNewColor(color)}
                aria-label={`Kleur ${color}`}
                aria-pressed={newColor === color}
                className={`h-6 w-6 rounded-full border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-brand-500 ${
                  newColor === color ? 'border-slate-900' : 'border-transparent'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
