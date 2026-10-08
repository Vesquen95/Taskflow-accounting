import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { reportError } from '../lib/errorMessage'
import { formatDate } from '../lib/urgency'
import { taakRegel } from '../lib/taakLabel'
import type { TaskInstanceWithRelations } from '../types'

interface OpenPost {
  id: string
  aangemaakt_op: string
  aangemaakt: { naam: string } | null
}

function vandaag(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * "Op de lijst te factureren" vanuit een taak (migratie 0069).
 *
 * Eén klik, zonder formulier: de omschrijving is de naam van de taak met haar
 * periode, de datum vandaag. Aanpassen kan daarna op het scherm Te
 * factureren. Staat de taak er al open op, dan zegt de knop dat in plaats van
 * een tweede regel te maken -- de databank zou die ook weigeren.
 */
export function TeFacturerenKnop({ task }: { task: TaskInstanceWithRelations }) {
  const [open, setOpen] = useState<OpenPost | null>(null)
  const [geladen, setGeladen] = useState(false)
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  const laad = useCallback(async () => {
    const { data, error } = await supabase
      .from('factuurposten')
      .select('id, aangemaakt_op, aangemaakt:employees!factuurposten_aangemaakt_door_fkey(naam)')
      .eq('task_instance_id', task.id)
      .eq('status', 'te_factureren')
      .maybeSingle()
    // Lukt het lezen niet, dan tonen we de knop gewoon niet: dit is een
    // gemak, geen onderdeel van de taak zelf.
    if (!error) {
      setOpen((data as unknown as OpenPost | null) ?? null)
      setGeladen(true)
    }
  }, [task.id])

  useEffect(() => {
    void laad()
  }, [laad])

  async function zetOpLijst() {
    setBezig(true)
    setFout(null)
    const regel = taakRegel(task)
    const { error } = await supabase.rpc('factuurpost_toevoegen', {
      p_client_id: task.client_id,
      p_omschrijving: regel.periode ? `${regel.naam} — ${regel.periode}` : regel.naam,
      p_uitgevoerd_op: vandaag(),
      p_task_instance_id: task.id,
      p_notitie: null,
    })
    setBezig(false)
    if (error) {
      setFout(reportError(error, 'Op de lijst te factureren'))
      return
    }
    await laad()
  }

  if (!geladen) return null

  return (
    <div className="text-xs">
      {open ? (
        <p className="text-slate-500">
          Staat op de lijst te factureren, sinds {formatDate(open.aangemaakt_op.slice(0, 10))}
          {open.aangemaakt?.naam ? ` (door ${open.aangemaakt.naam})` : ''}.
        </p>
      ) : (
        <button
          type="button"
          disabled={bezig}
          onClick={() => void zetOpLijst()}
          className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900 disabled:opacity-50"
        >
          {bezig ? 'Bezig…' : 'Op de lijst te factureren'}
        </button>
      )}
      {fout && (
        <p role="alert" className="mt-1 text-red-700">
          {fout}
        </p>
      )}
    </div>
  )
}
