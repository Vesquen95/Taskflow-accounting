import { supabase } from './supabase'
import { taakRegel } from './taakLabel'
import { isoDatum } from './werkstromen'
import { meldFactuurpostenGewijzigd } from './facturatie'
import type { FactuurpostStatus, TaskInstanceWithRelations } from '../types'

/**
 * Een taak op de lijst te factureren zetten (migratie 0069), vanuit drie
 * plaatsen: de knop in het taakvenster, de vraag na het afronden, en het
 * scherm Afgerond. Eén weg, zodat de omschrijving overal dezelfde is.
 */

type Taak = Pick<TaskInstanceWithRelations, 'id' | 'client_id' | 'title' | 'periode_label' | 'obligation_type'>

/** "Aangifte VenB — 2025": de naam van de taak met haar periode. */
export function factuurOmschrijving(task: Taak): string {
  const regel = taakRegel(task as TaskInstanceWithRelations)
  return regel.periode ? `${regel.naam} — ${regel.periode}` : regel.naam
}

/**
 * Zet de taak op de lijst, met vandaag als datum. Stond ze er al open op,
 * dan weigert de databank een tweede regel (23505); dat is geen fout voor wie
 * klikt, en dan zegt de uitkomst het.
 */
export async function zetTaakOpFactuurlijst(task: Taak): Promise<'toegevoegd' | 'stond_er_al'> {
  const { error } = await supabase.rpc('factuurpost_toevoegen', {
    p_client_id: task.client_id,
    p_omschrijving: factuurOmschrijving(task),
    p_uitgevoerd_op: isoDatum(new Date()),
    p_task_instance_id: task.id,
    p_notitie: null,
  })
  if (error) {
    if (error.code === '23505') return 'stond_er_al'
    throw error
  }
  meldFactuurpostenGewijzigd()
  return 'toegevoegd'
}

const VOORRANG: FactuurpostStatus[] = ['te_factureren', 'gefactureerd', 'niet_factureren']

/**
 * Per taak: staat ze op de factuurlijst, en hoe? Eén vraag voor een hele
 * lijst. Heeft een taak meerdere posten (een voorschot en een saldo), dan telt
 * de belangrijkste: wat nog te factureren is, eerst.
 */
export async function factuurstandVoorTaken(ids: string[]): Promise<Map<string, FactuurpostStatus>> {
  const standen = new Map<string, FactuurpostStatus>()
  if (ids.length === 0) return standen
  const { data, error } = await supabase
    .from('factuurposten')
    .select('task_instance_id, status')
    .in('task_instance_id', ids)
  if (error) throw error
  for (const rij of (data ?? []) as { task_instance_id: string | null; status: FactuurpostStatus }[]) {
    if (!rij.task_instance_id) continue
    const huidig = standen.get(rij.task_instance_id)
    if (!huidig || VOORRANG.indexOf(rij.status) < VOORRANG.indexOf(huidig)) standen.set(rij.task_instance_id, rij.status)
  }
  return standen
}
