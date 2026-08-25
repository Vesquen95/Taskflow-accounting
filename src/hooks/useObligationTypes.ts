import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { ObligationType } from '../types'

/** The fixed 8-row obligation-type catalogue (docs/PLAN.md §2.4/§2.5).
 * Rarely changes within a session, so this is a simple one-shot fetch. */
export function useObligationTypes() {
  const [obligationTypes, setObligationTypes] = useState<ObligationType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    supabase
      .from('obligation_types')
      .select('*')
      .order('naam', { ascending: true })
      .then(({ data, error: err }) => {
        if (!active) return
        if (err) {
          setError(err.message)
        } else {
          setObligationTypes((data ?? []) as ObligationType[])
        }
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return { obligationTypes, loading, error }
}
