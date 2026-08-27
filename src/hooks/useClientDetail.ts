import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type {
  Client,
  ClientChangeLogEntry,
  ClientObligation,
  ObligationType,
  TaskInstanceWithRelations,
} from '../types'
import { reportError } from '../lib/errorMessage'

export interface ClientObligationWithType extends ClientObligation {
  obligation_type: ObligationType
}

/** Klantdossier (§4 point 3): the client record, its configured
 * verplichtingen (effectief-gedateerd, so includes closed-off history),
 * and every task instance ever generated/created for it. */
export function useClientDetail(clientId: string | null) {
  const [client, setClient] = useState<Client | null>(null)
  const [obligations, setObligations] = useState<ClientObligationWithType[]>([])
  const [tasks, setTasks] = useState<TaskInstanceWithRelations[]>([])
  const [changeLog, setChangeLog] = useState<ClientChangeLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!clientId) {
      setClient(null)
      setObligations([])
      setTasks([])
      setChangeLog([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [clientRes, obligationsRes, tasksRes, changeLogRes] = await Promise.all([
        supabase.from('clients').select('*').eq('id', clientId).single(),
        supabase
          .from('client_obligations')
          .select('*, obligation_type:obligation_types(*)')
          .eq('client_id', clientId)
          .order('geldig_vanaf', { ascending: false }),
        supabase
          .from('task_instances')
          .select(
            '*, client:clients(id,naam,vertrouwelijk,actief), obligation_type:obligation_types(id,code,naam,categorie,werkstroom), toegewezen_medewerker:employees!task_instances_toegewezen_medewerker_id_fkey(id,naam)'
          )
          .eq('client_id', clientId)
          .order('due_date', { ascending: false }),
        // Het wijzigingslog van het dossier zelf: vertrouwelijkheid, btw-regime,
        // boekjaareinde, verantwoordelijke, en toegangverlening op een
        // vertrouwelijk dossier. Zonder dit blijft dat allemaal onzichtbaar.
        supabase
          .from('client_change_log')
          .select('*, actor:employees!client_change_log_actor_employee_id_fkey(id,naam)')
          .eq('client_id', clientId)
          .order('created_at', { ascending: false })
          .limit(50),
      ])

      if (clientRes.error) throw clientRes.error
      if (obligationsRes.error) throw obligationsRes.error
      if (tasksRes.error) throw tasksRes.error
      if (changeLogRes.error) throw changeLogRes.error

      setClient(clientRes.data as Client)
      setObligations((obligationsRes.data ?? []) as unknown as ClientObligationWithType[])
      setTasks((tasksRes.data ?? []) as unknown as TaskInstanceWithRelations[])
      setChangeLog((changeLogRes.data ?? []) as unknown as ClientChangeLogEntry[])
    } catch (err) {
      setError(reportError(err, 'Kon klantdossier niet laden'))
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    load()
  }, [load])

  /** Effectief-gedateerd change (§2.6): close the current active row and
   * open a fresh one with the new parameters, rather than overwriting. */
  async function updateObligationParameters(
    obligationRowId: string,
    obligationTypeId: string,
    newParameters: Record<string, unknown>,
    newAssignee: string | null
  ) {
    if (!clientId) return
    const today = new Date().toISOString().slice(0, 10)
    const { error: closeErr } = await supabase
      .from('client_obligations')
      .update({ actief: false, geldig_tot: today })
      .eq('id', obligationRowId)
    if (closeErr) throw closeErr

    const { error: openErr } = await supabase.from('client_obligations').insert({
      client_id: clientId,
      obligation_type_id: obligationTypeId,
      actief: true,
      geldig_vanaf: today,
      parameters: newParameters,
      standaard_toegewezen_medewerker_id: newAssignee,
    })
    if (openErr) throw openErr
    await load()
  }

  async function addObligation(input: {
    obligation_type_id: string
    parameters: Record<string, unknown>
    standaard_toegewezen_medewerker_id: string | null
  }) {
    if (!clientId) return
    const { error: err } = await supabase.from('client_obligations').insert({
      client_id: clientId,
      obligation_type_id: input.obligation_type_id,
      actief: true,
      geldig_vanaf: new Date().toISOString().slice(0, 10),
      parameters: input.parameters,
      standaard_toegewezen_medewerker_id: input.standaard_toegewezen_medewerker_id,
    })
    if (err) throw err
    await load()
  }

  async function deactivateObligation(obligationRowId: string) {
    const { error: err } = await supabase
      .from('client_obligations')
      .update({ actief: false, geldig_tot: new Date().toISOString().slice(0, 10) })
      .eq('id', obligationRowId)
    if (err) throw err
    await load()
  }

  async function createAdhocTask(input: { title: string; description: string | null; due_date: string; toegewezen_medewerker_id: string }) {
    if (!clientId) return
    const { error: err } = await supabase.from('task_instances').insert({
      client_id: clientId,
      obligation_type_id: null,
      client_obligation_id: null,
      title: input.title,
      description: input.description,
      due_date: input.due_date,
      due_date_wettelijk: input.due_date,
      status: 'open',
      toegewezen_medewerker_id: input.toegewezen_medewerker_id,
      bron_type: 'handmatig_adhoc',
      vereist_goedkeuring: false,
    })
    if (err) throw err
    await load()
  }

  return {
    client,
    obligations,
    tasks,
    changeLog,
    loading,
    error,
    reload: load,
    updateObligationParameters,
    addObligation,
    deactivateObligation,
    createAdhocTask,
  }
}
