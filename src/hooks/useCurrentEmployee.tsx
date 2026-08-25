import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Employee } from '../types'
import { useAuth } from './useAuth'
import { reportError } from '../lib/errorMessage'

interface CurrentEmployeeContextValue {
  /** The employees row linked to the logged-in auth user, or null when
   * this auth user has not completed onboarding yet (no firm/invite
   * claimed). */
  employee: Employee | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

const CurrentEmployeeContext = createContext<CurrentEmployeeContextValue | undefined>(undefined)

export function CurrentEmployeeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) {
      setEmployee(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('employees')
        .select('*')
        .eq('auth_user_id', user.id)
        .maybeSingle()
      if (err) throw err
      setEmployee((data as Employee | null) ?? null)
    } catch (err) {
      setError(reportError(err, 'Kon medewerkersprofiel niet laden'))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  return (
    <CurrentEmployeeContext.Provider value={{ employee, loading, error, reload: load }}>
      {children}
    </CurrentEmployeeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- co-locating the hook with its provider is intentional here
export function useCurrentEmployee() {
  const ctx = useContext(CurrentEmployeeContext)
  if (!ctx) throw new Error('useCurrentEmployee must be used within a CurrentEmployeeProvider')
  return ctx
}
