import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Employee, EmployeeRol } from '../types'
import { reportError } from '../lib/errorMessage'

/** Colleagues within the current employee's firm (RLS already scopes this
 * to `firm_id = current_employee_firm_id()` — see 0005_domain_rls.sql). */
export function useEmployees() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.from('employees').select('*').order('naam', { ascending: true })
      if (err) throw err
      setEmployees((data ?? []) as Employee[])
    } catch (err) {
      setError(reportError(err, 'Kon medewerkers niet laden'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function inviteEmployee(input: { naam: string; email: string; rol: EmployeeRol; mag_goedkeuren: boolean }) {
    const { error: err } = await supabase.rpc('invite_employee', {
      p_naam: input.naam,
      p_email: input.email,
      p_rol: input.rol,
      p_mag_goedkeuren: input.mag_goedkeuren,
    })
    if (err) throw err
    await load()
  }

  async function updateEmployee(
    id: string,
    updates: Partial<Pick<Employee, 'naam' | 'rol' | 'mag_goedkeuren' | 'actief'>>
  ) {
    const { error: err } = await supabase.from('employees').update(updates).eq('id', id)
    if (err) throw err
    await load()
  }

  return { employees, loading, error, reload: load, inviteEmployee, updateEmployee }
}
