import { supabase } from './supabase'
import { meldStatusGewijzigd } from '../hooks/useTeKeuren'
import type { Employee, TaskInstanceWithRelations } from '../types'

/**
 * Wie mag een afgeronde taak heropenen (migratie 0070)? Dezelfde grens als
 * de databank: wie mag goedkeuren of kantoorbeheerder is altijd; de
 * verantwoordelijke zelf alleen bij een taak zonder goedkeuring. Een
 * goedgekeurde aangifte terugdraaien is een beslissing van wie goedkeurt.
 */
export function magHeropenen(
  task: Pick<TaskInstanceWithRelations, 'status' | 'vereist_goedkeuring' | 'toegewezen_medewerker_id'>,
  employee: Pick<Employee, 'id' | 'rol' | 'mag_goedkeuren'> | null
): boolean {
  if (!employee || task.status !== 'ingediend_afgerond') return false
  if (employee.rol === 'kantoorbeheerder' || employee.mag_goedkeuren) return true
  return !task.vereist_goedkeuring && task.toegewezen_medewerker_id === employee.id
}

/** Heropent via de databank, die de reden en wie het deed in de historiek zet. */
export async function heropenTaak(taskId: string, reden: string): Promise<void> {
  const { error } = await supabase.rpc('taak_heropenen', { p_task_id: taskId, p_reden: reden })
  if (error) throw error
  // Het getal naast Goedkeuren en de werklijsten tellen opnieuw.
  meldStatusGewijzigd()
}
