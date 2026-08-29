import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { TaskInstanceWithRelations, TaskStatus } from '../types'
import { reportError } from '../lib/errorMessage'
import { voerBulkUit, type BulkResultaat } from '../lib/bulkActie'

/** De velden die een bulkactie mag schrijven — één status of één toewijzing. */
type TaakPatch = { status: TaskStatus } | { toegewezen_medewerker_id: string }

const NOT_FINAL: TaskStatus[] = ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']

export interface TaskInstanceFilters {
  /** undefined = all non-final statuses (the common "actief" default). */
  status?: TaskStatus[]
  toegewezenAan?: string | 'alle'
  clientId?: string
  overdueOnly?: boolean
  reviewVereist?: boolean
  zoekterm?: string
  /** Beperk tot deze verplichtingstypes -- zo staat één werkstroom op het
   *  scherm. De indeling zelf staat in de catalogus (migratie 0022); dit
   *  scherm krijgt alleen de ids die eruit volgen. Een lege lijst levert
   *  bewust niets op: dat is een stroom zonder types, geen "toon alles". */
  obligationTypeIds?: string[]
  /** Alleen taken zonder verplichtingstype -- de ad-hoc ingang. */
  adhocOnly?: boolean
  /** Bovengrens van het deadlinevenster (ISO-datum, inclusief). Er is geen
   *  ondergrens: wat te laat is hoort in elk venster thuis. */
  dueTot?: string
  /** Nog niet bevragen. Een scherm dat zijn filters pas kent na een eerste
   *  ronde (de werkstromen halen hun verplichtingstypes uit de catalogus) zou
   *  anders eerst een query afvuren die het meteen weer overdoet. */
  paused?: boolean
  /** Include everything, including geannuleerd/ingediend_afgerond — used
   * by the Klantdossier history view. Overrides `status`. */
  includeAlles?: boolean
}

const SELECT_WITH_RELATIONS =
  '*, client:clients(id,naam,vertrouwelijk,actief), obligation_type:obligation_types(id,code,naam,categorie,werkstroom), toegewezen_medewerker:employees!task_instances_toegewezen_medewerker_id_fkey(id,naam)'

/** Shared data source for Werklijst, Mijn taken, and de Escalatie-queue
 * (§4 points 1/2/5) — a firm-wide, cross-client list of task instances
 * with server-side filtering (RLS still applies underneath: confidential
 * clients this employee can't see are already excluded by Postgres). */
export function useTaskInstances(initialFilters: TaskInstanceFilters = {}) {
  const [tasks, setTasks] = useState<TaskInstanceWithRelations[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<TaskInstanceFilters>(initialFilters)

  const load = useCallback(async () => {
    // Gepauzeerd: loading blijft staan, zodat het scherm "Laden…" toont in
    // plaats van kort "geen taken" voor de echte filters bekend zijn.
    if (filters.paused) return
    setLoading(true)
    setError(null)
    try {
      let query = supabase.from('task_instances').select(SELECT_WITH_RELATIONS)

      if (!filters.includeAlles) {
        query = query.in('status', filters.status ?? NOT_FINAL)
      }
      if (filters.toegewezenAan && filters.toegewezenAan !== 'alle') {
        query = query.eq('toegewezen_medewerker_id', filters.toegewezenAan)
      }
      if (filters.clientId) {
        query = query.eq('client_id', filters.clientId)
      }
      if (filters.overdueOnly) {
        query = query.lt('due_date', new Date().toISOString().slice(0, 10))
      }
      if (filters.reviewVereist) {
        query = query.eq('review_vereist', true)
      }
      if (filters.adhocOnly) {
        query = query.is('obligation_type_id', null)
      } else if (filters.obligationTypeIds) {
        query = query.in('obligation_type_id', filters.obligationTypeIds)
      }
      if (filters.dueTot) {
        query = query.lte('due_date', filters.dueTot)
      }

      const { data, error: err } = await query.order('due_date', { ascending: true })
      if (err) throw err

      let rows = (data ?? []) as unknown as TaskInstanceWithRelations[]
      if (filters.zoekterm && filters.zoekterm.trim().length > 0) {
        const term = filters.zoekterm.trim().toLowerCase()
        rows = rows.filter(
          (t) =>
            t.client?.naam?.toLowerCase().includes(term) ||
            t.obligation_type?.naam?.toLowerCase().includes(term) ||
            (t.title ?? '').toLowerCase().includes(term)
        )
      }
      setTasks(rows)
    } catch (err) {
      setError(reportError(err, 'Kon taken niet laden'))
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    load()
  }, [load])

  async function updateStatus(taskId: string, status: TaskStatus) {
    const { error: err } = await supabase.from('task_instances').update({ status }).eq('id', taskId)
    if (err) throw err
    await load()
  }

  async function reassign(taskId: string, toegewezen_medewerker_id: string) {
    const { error: err } = await supabase.from('task_instances').update({ toegewezen_medewerker_id }).eq('id', taskId)
    if (err) throw err
    await load()
  }

  /**
   * Eén update over een lijst ids. Geeft terug wélke rijen de databank
   * effectief bijgewerkt heeft: `.select('id')` is hier geen luxe, want RLS
   * laat een onzichtbare rij zonder fout buiten de update vallen.
   */
  async function updateTaken(ids: string[], patch: TaakPatch): Promise<string[]> {
    const query = supabase.from('task_instances').update(patch)
    const { data, error: err } = await (ids.length === 1
      ? query.eq('id', ids[0])
      : query.in('id', ids)
    ).select('id')
    if (err) throw err
    return ((data ?? []) as Array<{ id: string }>).map((rij) => rij.id)
  }

  /**
   * Bulk met verslag: snelle weg eerst, per taak uitzoeken wanneer de
   * databank de ene opdracht weigert. Zie src/lib/bulkActie.ts voor de
   * afweging. Gooit bewust niet meer bij een deelweigering — het verslag ís
   * het antwoord, en de UI toont het per taak.
   */
  async function bulkPatch(taskIds: string[], patch: TaakPatch): Promise<BulkResultaat> {
    const resultaat = await voerBulkUit(
      taskIds,
      (ids) => updateTaken(ids, patch),
      async (id) => (await updateTaken([id], patch)).length > 0
    )
    await load()
    return resultaat
  }

  async function bulkReassign(taskIds: string[], toegewezen_medewerker_id: string): Promise<BulkResultaat> {
    return bulkPatch(taskIds, { toegewezen_medewerker_id })
  }

  async function bulkUpdateStatus(taskIds: string[], status: TaskStatus): Promise<BulkResultaat> {
    return bulkPatch(taskIds, { status })
  }

  async function markReviewHandled(taskId: string) {
    const { error: err } = await supabase
      .from('task_instances')
      .update({ review_vereist: false })
      .eq('id', taskId)
    if (err) throw err
    await load()
  }

  return {
    tasks,
    loading,
    error,
    filters,
    setFilters,
    reload: load,
    updateStatus,
    reassign,
    bulkReassign,
    bulkUpdateStatus,
    markReviewHandled,
  }
}
