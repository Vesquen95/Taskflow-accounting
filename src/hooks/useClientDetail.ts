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

  /**
   * Een einddatum op een lopende verplichting: ze blijft actief, maar levert
   * geen taken meer op voor een periode NA die datum (migratie 0053).
   *
   * Het schoolvoorbeeld is een vereffening. `actief` blijft bewust op true:
   * de verplichting loopt nog, ze heeft alleen een horizon. Pas wanneer de
   * datum voorbij is, valt ze vanzelf uit de selectie van de motor.
   *
   * `null` haalt de einddatum weer weg -- een vereffening die langer duurt dan
   * gedacht, of een datum die verkeerd getypt was.
   */
  async function setObligationEinddatum(obligationRowId: string, geldigTot: string | null) {
    const { error: err } = await supabase
      .from('client_obligations')
      .update({ geldig_tot: geldigTot })
      .eq('id', obligationRowId)
    if (err) throw err
    // De opruiming en de aanvulling zitten allebei in sync_client_tasks: wat
    // over een periode na de einddatum gaat wordt geannuleerd, en een
    // teruggedraaide einddatum levert de taken weer op.
    if (clientId) {
      const { error: syncErr } = await supabase.rpc('sync_client_tasks', { p_client_id: clientId })
      if (syncErr) throw syncErr
    }
    await load()
  }

  /** De ontbinding. Verandert niets aan de verplichtingen: de vennootschap
   *  blijft bestaan vóór haar vereffening (art. 2:76 WVV). `null` draait ze
   *  terug. */
  async function setOntbondenOp(datum: string | null) {
    if (!clientId) return
    const { error: err } = await supabase
      .from('clients')
      .update({ ontbonden_op: datum })
      .eq('id', clientId)
    if (err) throw err
    await load()
  }

  /** De sluiting van de vereffening. Zet de datum op het dossier én als
   *  einddatum op elke lopende verplichting, in één beweging -- los van elkaar
   *  zetten zou een dossier opleveren dat "vereffend" zegt en intussen taken
   *  blijft maken (migratie 0054). `null` draait de sluiting terug. */
  async function setVereffendOp(datum: string | null) {
    if (!clientId) return
    const { error: err } = await supabase.rpc('klant_vereffend', {
      p_client_id: clientId,
      p_datum: datum,
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

  /**
   * Een klant archiveren. De databank doet de rest: de trigger uit migratie
   * 0026 annuleert alle nog niet afgesloten taken van dit dossier en laat er
   * per taak een spoor van na. Vandaar dat hier maar één kolom gezet wordt —
   * de opruiming hoort niet in de app, anders klopt ze alleen wanneer ze via
   * dit scherm loopt.
   */
  async function archiveClient() {
    if (!clientId) return
    const { error: err } = await supabase.from('clients').update({ actief: false }).eq('id', clientId)
    if (err) throw err
    await load()
  }

  /**
   * En terug. De geannuleerde taken komen niet terug (ze zijn geannuleerd,
   * niet vergeten), maar de verplichtingen lopen nog, dus de generator maakt
   * meteen nieuwe taken aan — dat hoeft niet tot de maandelijkse
   * onderhoudsronde te wachten. Dezelfde aanroep als bij het opslaan van een
   * klant (sync_client_tasks, migratie 0021).
   */
  async function reactivateClient() {
    if (!clientId) return
    const { error: err } = await supabase.from('clients').update({ actief: true }).eq('id', clientId)
    if (err) throw err
    const { error: syncErr } = await supabase.rpc('sync_client_tasks', { p_client_id: clientId })
    if (syncErr) throw syncErr
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
    setObligationEinddatum,
    setOntbondenOp,
    setVereffendOp,
    createAdhocTask,
    archiveClient,
    reactivateClient,
  }
}
