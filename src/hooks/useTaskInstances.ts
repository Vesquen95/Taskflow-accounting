import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { TaskInstanceWithRelations, TaskStatus } from '../types'
import { reportError } from '../lib/errorMessage'
import { voerBulkUit, type BulkResultaat } from '../lib/bulkActie'

/** De velden die een bulkactie mag schrijven — één status of één toewijzing. */
type TaakPatch = { status: TaskStatus } | { toegewezen_medewerker_id: string | null }

const NOT_FINAL: TaskStatus[] = ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']

/** De stand van het medewerkersfilter die "nog niemand" betekent. */
export const TEAMBAK = 'teambak' as const

export interface TaskInstanceFilters {
  /** Een medewerker-id, 'alle', of TEAMBAK voor het werk dat nog niemand
   *  opgenomen heeft. Die derde stand hoort hier en niet in een eigen filter:
   *  op het scherm is het dezelfde keuzelijst, en twee filters die elkaar
   *  kunnen tegenspreken is een bug die op je wacht. */
  toegewezenAan?: string | 'alle' | typeof TEAMBAK
  zoekterm?: string
  /** Beperk tot deze verplichtingstypes -- zo staat één werkstroom op het
   *  scherm. De indeling zelf staat in de catalogus (migratie 0022); dit
   *  scherm krijgt alleen de ids die eruit volgen. Een lege lijst levert
   *  bewust niets op: dat is een stroom zonder types, geen "toon alles". */
  obligationTypeIds?: string[]
  /** Alleen taken zonder verplichtingstype -- de ad-hoc ingang. */
  adhocOnly?: boolean
  /** Beperk tot de dossiers van dit team. 'alle' of leeg = geen beperking --
   *  en dat is geen achterpoort: wat je niet mag zien, laat RLS er sowieso
   *  niet uit (migratie 0039). Dit filter dient om te focussen, niet om af te
   *  schermen. */
  team?: string | 'alle'
  /** Bovengrens van het deadlinevenster (ISO-datum, inclusief). Er is geen
   *  ondergrens tenzij een scherm er expliciet om vraagt (`dueVanaf`): wat te
   *  laat is hoort in elk venster thuis. */
  dueTot?: string
  /** Ondergrens van het deadlinevenster (ISO-datum, inclusief). Enkel voor
   *  het scherm dat de historische achterstand bewust wegfiltert; zet dan ook
   *  `telAchterstandVoor`, anders verdwijnt werk zonder dat iemand het ziet. */
  dueVanaf?: string
  /** Serverside paginering, 1-gebaseerd. Zonder `paginaGrootte` blijft de
   *  query onbegrensd (het oude gedrag van de smalle werkstroomschermen). */
  pagina?: number
  paginaGrootte?: number
  /** Tel apart hoeveel taken vóór deze ISO-datum vervallen zijn — met
   *  dezelfde afbakening als de lijst, maar zonder `dueVanaf`. Zo kan het
   *  scherm zeggen hoeveel achterstand het verbergt. */
  telAchterstandVoor?: string
  /** Nog niet bevragen. Een scherm dat zijn filters pas kent na een eerste
   *  ronde (de werkstromen halen hun verplichtingstypes uit de catalogus) zou
   *  anders eerst een query afvuren die het meteen weer overdoet. */
  paused?: boolean
}

/** `clients!inner` en niet `clients`: op een gewone embed kan PostgREST niet
 *  filteren, en het teamfilter doet precies dat (`client.team_id`). Elke taak
 *  heeft sowieso een klant, dus de inner join laat niets extra weg. */
const SELECT_WITH_RELATIONS =
  '*, client:clients!inner(id,naam,vertrouwelijk,actief,team_id), obligation_type:obligation_types(id,code,naam,categorie,werkstroom), toegewezen_medewerker:employees!task_instances_toegewezen_medewerker_id_fkey(id,naam)'

/** Dezelfde afbakening voor de tellingen, die geen rijen ophalen maar wel op
 *  het team moeten kunnen filteren. */
const SELECT_VOOR_TELLING = 'id, client:clients!inner(team_id)'

/** Gedeelde bron voor de werkschermen: de werkstromen, de kalender en het
 * workload-dashboard. Kantoorbrede, klant-overschrijdende lijst van
 * taakinstanties met server-side filtering (RLS geldt eronder: een
 * vertrouwelijke klant die deze medewerker niet mag zien, komt er door
 * Postgres al niet uit).
 *
 * Altijd enkel de niet-afgesloten statussen: de historiek van één dossier
 * (inclusief geannuleerd/ingediend) haalt het klantdossier via
 * useClientDetail op, met een eigen query. */
export function useTaskInstances(initialFilters: TaskInstanceFilters = {}) {
  const [tasks, setTasks] = useState<TaskInstanceWithRelations[]>([])
  const [totaal, setTotaal] = useState<number | null>(null)
  const [achterstandAantal, setAchterstandAantal] = useState<number | null>(null)
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
      // Eén plek waar de afbakening staat, want de lijst en de telling van de
      // achterstand moeten exact dezelfde taken zien. Enkel de ondergrens
      // verschilt: die telling gaat juist over wat de lijst wegfiltert.
      const afgebakend = (
        kolommen: string,
        opties: { count: 'exact'; head?: boolean },
        metOndergrens: boolean
      ) => {
        let query = supabase
          .from('task_instances')
          .select(kolommen, opties)
          .in('status', NOT_FINAL)

        if (filters.toegewezenAan === TEAMBAK) {
          query = query.is('toegewezen_medewerker_id', null)
        } else if (filters.toegewezenAan && filters.toegewezenAan !== 'alle') {
          query = query.eq('toegewezen_medewerker_id', filters.toegewezenAan)
        }
        if (filters.adhocOnly) {
          query = query.is('obligation_type_id', null)
        } else if (filters.obligationTypeIds) {
          query = query.in('obligation_type_id', filters.obligationTypeIds)
        }
        if (filters.team && filters.team !== 'alle') {
          query = query.eq('client.team_id', filters.team)
        }
        if (filters.dueTot) {
          query = query.lte('due_date', filters.dueTot)
        }
        if (metOndergrens && filters.dueVanaf) {
          query = query.gte('due_date', filters.dueVanaf)
        }
        return query
      }

      // Op due_date én id sorteren: zonder tweede sleutel is de volgorde van
      // taken met dezelfde deadline niet vastgelegd, en dan kan een rij bij
      // het bladeren tussen twee pagina's door vallen of dubbel verschijnen.
      let lijst = afgebakend(SELECT_WITH_RELATIONS, { count: 'exact' }, true)
        .order('due_date', { ascending: true })
        .order('id', { ascending: true })

      const grootte = filters.paginaGrootte
      if (grootte && grootte > 0) {
        const van = (Math.max(1, filters.pagina ?? 1) - 1) * grootte
        lijst = lijst.range(van, van + grootte - 1)
      }

      const [lijstRes, achterstandRes] = await Promise.all([
        lijst,
        filters.telAchterstandVoor
          ? afgebakend(SELECT_VOOR_TELLING, { count: 'exact', head: true }, false).lt(
              'due_date',
              filters.telAchterstandVoor
            )
          : Promise.resolve(null),
      ])

      if (lijstRes.error) throw lijstRes.error
      if (achterstandRes?.error) throw achterstandRes.error

      let rows = (lijstRes.data ?? []) as unknown as TaskInstanceWithRelations[]
      const zoekterm = filters.zoekterm?.trim().toLowerCase()
      if (zoekterm) {
        rows = rows.filter(
          (t) =>
            t.client?.naam?.toLowerCase().includes(zoekterm) ||
            t.obligation_type?.naam?.toLowerCase().includes(zoekterm) ||
            (t.title ?? '').toLowerCase().includes(zoekterm)
        )
      }
      setTasks(rows)
      // De zoekterm filtert client-side, dus het servertotaal slaat dan op een
      // ruimere verzameling dan wat op het scherm staat. Liever geen getal dan
      // een getal dat niet bij de lijst hoort.
      setTotaal(zoekterm || typeof lijstRes.count !== 'number' ? null : lijstRes.count)
      setAchterstandAantal(achterstandRes ? achterstandRes.count ?? 0 : null)
    } catch (err) {
      setError(reportError(err, 'Kon taken niet laden'))
      setTotaal(null)
      setAchterstandAantal(null)
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

  async function reassign(taskId: string, toegewezen_medewerker_id: string | null) {
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

  async function bulkReassign(taskIds: string[], toegewezen_medewerker_id: string | null): Promise<BulkResultaat> {
    return bulkPatch(taskIds, { toegewezen_medewerker_id })
  }

  async function bulkUpdateStatus(taskIds: string[], status: TaskStatus): Promise<BulkResultaat> {
    return bulkPatch(taskIds, { status })
  }

  /**
   * Een deadline handmatig verzetten (bevinding L). Enkel `due_date` gaat mee:
   * migratie 0013 zet zelf `due_date_handmatig_op`, schrijft de logregel
   * 'due_date_herberekend' met oude en nieuwe datum, en weigert een wijziging
   * van `due_date_wettelijk` buiten de kalenderpijplijn om. De app hoort daar
   * niets aan toe te voegen — die datum blijft de wettelijke.
   */
  async function updateDueDate(taskId: string, dueDate: string) {
    const { error: err } = await supabase
      .from('task_instances')
      .update({ due_date: dueDate })
      .eq('id', taskId)
    if (err) throw err
    await load()
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
    /** Het werkelijke aantal rijen achter de filters, niet het aantal
     *  opgehaalde rijen. Null wanneer de zoekterm client-side filtert. */
    totaal,
    /** Aantal taken dat vóór `filters.telAchterstandVoor` vervalt, ook als de
     *  lijst ze wegfiltert. Null wanneer het scherm er niet om vroeg. */
    achterstandAantal,
    loading,
    error,
    filters,
    setFilters,
    reload: load,
    updateStatus,
    updateDueDate,
    reassign,
    bulkReassign,
    bulkUpdateStatus,
    markReviewHandled,
  }
}
