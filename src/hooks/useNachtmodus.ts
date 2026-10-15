import { useEffect, useState } from 'react'
import { bewaarNachtmodus, leesNachtmodus, NACHTMODUS_SLEUTEL, pasNachtmodusToe } from '../lib/nachtmodus'

/** Aan of uit, en schakelen. Volgt ook een ander tabblad dat omschakelt. */
export function useNachtmodus(): [boolean, (aan: boolean) => void] {
  const [aan, setAan] = useState(leesNachtmodus)

  useEffect(() => {
    function opOpslag(e: StorageEvent) {
      if (e.key !== NACHTMODUS_SLEUTEL) return
      const nu = e.newValue === 'aan'
      pasNachtmodusToe(nu)
      setAan(nu)
    }
    window.addEventListener('storage', opOpslag)
    return () => window.removeEventListener('storage', opOpslag)
  }, [])

  function zet(nieuw: boolean) {
    bewaarNachtmodus(nieuw)
    setAan(nieuw)
  }

  return [aan, zet]
}
