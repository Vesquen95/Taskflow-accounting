import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useAuth } from './useAuth'
import { useSessieBewaking } from './useSessieBewaking'
import type { Sessiestand, Verloopreden } from '../lib/sessieduur'

/**
 * De sessiebewaking, één keer, gedeeld door wie ze nodig heeft.
 *
 * Twee onderdelen kijken ernaar: de waarschuwing die aftelt, en de knop in de
 * zijbalk waarmee je de sessie twaalf uur openhoudt. Zouden die elk hun eigen
 * `useSessieBewaking()` aanroepen, dan lopen er twee tellers naast elkaar die
 * allebei afmelden en elk hun eigen idee hebben van wanneer.
 *
 * Twee contexten, geen één. De stand tikt: elke seconde tijdens de
 * waarschuwing, elke vijf seconden daarbuiten. Wie alleen de knop nodig heeft
 * hoort daar niet bij mee te tekenen, en de bediening verandert alleen als je
 * er zelf op drukt.
 */

export interface Sessiestandaard {
  stand: Sessiestand
  reden?: Verloopreden
  secondenResterend: number
}

export interface Sessiebediening {
  blijfAangemeld: () => void
  langeSessie: boolean
  zetLangeSessie: (aan: boolean) => void
  eindeSessie: number | null
}

const StandContext = createContext<Sessiestandaard | undefined>(undefined)
const BedieningContext = createContext<Sessiebediening | undefined>(undefined)

export function SessieProvider({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth()
  const bewaking = useSessieBewaking(user?.id ?? null, signOut)

  const stand = useMemo<Sessiestandaard>(
    () => ({
      stand: bewaking.stand,
      reden: bewaking.reden,
      secondenResterend: bewaking.secondenResterend,
    }),
    [bewaking.stand, bewaking.reden, bewaking.secondenResterend]
  )

  const bediening = useMemo<Sessiebediening>(
    () => ({
      blijfAangemeld: bewaking.blijfAangemeld,
      langeSessie: bewaking.langeSessie,
      zetLangeSessie: bewaking.zetLangeSessie,
      eindeSessie: bewaking.eindeSessie,
    }),
    [bewaking.blijfAangemeld, bewaking.langeSessie, bewaking.zetLangeSessie, bewaking.eindeSessie]
  )

  return (
    <BedieningContext.Provider value={bediening}>
      <StandContext.Provider value={stand}>{children}</StandContext.Provider>
    </BedieningContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- de haken horen bij hun provider
export function useSessiestand(): Sessiestandaard {
  const ctx = useContext(StandContext)
  if (!ctx) throw new Error('useSessiestand hoort binnen een SessieProvider')
  return ctx
}

// eslint-disable-next-line react-refresh/only-export-components -- idem
export function useSessiebediening(): Sessiebediening {
  const ctx = useContext(BedieningContext)
  if (!ctx) throw new Error('useSessiebediening hoort binnen een SessieProvider')
  return ctx
}
