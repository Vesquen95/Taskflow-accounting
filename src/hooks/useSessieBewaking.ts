import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  beoordeelSessie,
  eindeVanDeSessie,
  type Sessiestand,
  type Verloopreden,
} from '../lib/sessieduur'
import {
  bewaarVerloopreden,
  leesActiviteit,
  leesLangeSessie,
  leesStart,
  schrijfLangeSessie,
  schrijfActiviteit,
  schrijfStart,
  wisSessiestempels,
} from '../lib/sessieopslag'

/**
 * Gebeurtenissen die als "er zit iemand achter dit scherm" tellen.
 *
 * Bewust geen 'mousemove': een muis die tegen een boekenkast leunt, een
 * bureaustoel die tegen de tafel duwt, of een collega die langsloopt houdt
 * de sessie dan eeuwig open -- precies wat we willen vermijden.
 */
const ACTIVITEIT = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

/** Niet bij elke toetsaanslag naar de opslag schrijven. */
const SCHRIJFPAUZE_MS = 5_000

export interface Sessiebewaking {
  stand: Sessiestand
  reden?: Verloopreden
  secondenResterend: number
  /** Zet de teller terug. Werkt niet tegen de absolute grens; zie hieronder. */
  blijfAangemeld: () => void
  /** Staat de inactiviteitsgrens opzij voor deze aanmelding. */
  langeSessie: boolean
  zetLangeSessie: (aan: boolean) => void
  /** Het moment waarop deze aanmelding hoe dan ook afloopt; null zonder sessie. */
  eindeSessie: number | null
}

/**
 * Houdt de sessie in de gaten en meldt zelf af als ze afgelopen is.
 *
 * `uid` is het gebruikers-id van de aangemelde gebruiker, of null als er
 * niemand aangemeld is. De hook mag altijd aangeroepen worden -- bij null
 * doet ze niets.
 */
export function useSessieBewaking(
  uid: string | null,
  signOut: () => Promise<void>
): Sessiebewaking {
  const startRef = useRef<number | null>(null)
  const activiteitRef = useRef<number>(Date.now())
  const afgemeldRef = useRef(false)

  // Eén peiling: het aanmeldmoment, de laatste activiteit en de klok, samen
  // in één toestand. Dat "samen" is niet cosmetisch. Toen alleen de klok in
  // de toestand zat, sloeg React de her-tekening over zodra Date.now()
  // toevallig hetzelfde was, en bleef een sessie die bij het opstarten al
  // verlopen was nog een tik lang gewoon open staan. Een nieuw object per
  // peiling kan dat niet overkomen.
  const langRef = useRef(false)
  const [peiling, setPeiling] = useState(() => ({
    start: null as number | null,
    activiteit: Date.now(),
    nu: Date.now(),
    lang: false,
  }))

  const meet = useCallback(() => {
    // Een ander tabblad kan een verser stempel geschreven hebben.
    const gedeeld = leesActiviteit()
    if (gedeeld !== null && gedeeld > activiteitRef.current) {
      activiteitRef.current = gedeeld
    }
    setPeiling({
      start: startRef.current,
      activiteit: activiteitRef.current,
      nu: Date.now(),
      lang: langRef.current,
    })
  }, [])

  // Het aanmeldmoment en de laatste activiteit komen bij voorkeur uit de
  // opslag. Dat is niet alleen voor andere tabbladen: het is ook wat een
  // browser die gisteravond open bleef staan meteen buiten zet. Zonder deze
  // regel zou de bewaarde Supabase-sessie de volgende ochtend gewoon weer
  // openklappen -- precies de klacht waar dit uit voortkomt.
  useEffect(() => {
    if (!uid) {
      startRef.current = null
      return
    }
    afgemeldRef.current = false
    const nuMs = Date.now()
    const bewaardeStart = leesStart(uid)
    startRef.current = bewaardeStart ?? nuMs
    if (bewaardeStart === null) schrijfStart(uid, nuMs)
    const bewaardeActiviteit = leesActiviteit()
    activiteitRef.current = bewaardeActiviteit ?? nuMs
    if (bewaardeActiviteit === null) schrijfActiviteit(nuMs)
    langRef.current = leesLangeSessie(uid)
    meet()
  }, [uid, meet])

  const oordeel = useMemo(() => {
    if (!uid || peiling.start === null) {
      return { stand: 'actief' as Sessiestand, secondenResterend: 0 }
    }
    return beoordeelSessie(peiling.start, peiling.activiteit, peiling.nu, peiling.lang)
  }, [uid, peiling])

  const standRef = useRef<Sessiestand>(oordeel.stand)
  standRef.current = oordeel.stand

  // Rustig tikken zolang er niets aan de hand is, per seconde zodra de
  // waarschuwing staat -- daar loopt een aftelling die moet kloppen.
  useEffect(() => {
    if (!uid) return
    const tussenpoos = oordeel.stand === 'actief' ? 5_000 : 1_000
    const id = window.setInterval(meet, tussenpoos)
    return () => window.clearInterval(id)
  }, [uid, oordeel.stand, meet])

  useEffect(() => {
    if (!uid) return
    let laatstGeschreven = 0
    function registreer() {
      // Zodra de waarschuwing staat telt alleen nog de knop. Anders zou het
      // wegklikken van de waarschuwing zelf, of een muis die er langs
      // strijkt, de afmelding stilzwijgend uitstellen: dan vraag je iets en
      // beslis je het zelf.
      if (standRef.current !== 'actief') return
      const moment = Date.now()
      activiteitRef.current = moment
      if (moment - laatstGeschreven > SCHRIJFPAUZE_MS) {
        laatstGeschreven = moment
        schrijfActiviteit(moment)
      }
    }
    for (const naam of ACTIVITEIT) {
      window.addEventListener(naam, registreer, { passive: true })
    }
    return () => {
      for (const naam of ACTIVITEIT) window.removeEventListener(naam, registreer)
    }
  }, [uid])

  useEffect(() => {
    if (!uid || oordeel.stand !== 'verlopen' || afgemeldRef.current) return
    // Eén keer. `signOut` maakt de sessie null, maar tot die ronde geverfd is
    // blijft dit effect anders opnieuw afvuren.
    afgemeldRef.current = true
    bewaarVerloopreden(oordeel.reden ?? 'inactiviteit')
    wisSessiestempels()
    void signOut()
  }, [uid, oordeel, signOut])

  const blijfAangemeld = useCallback(() => {
    const moment = Date.now()
    activiteitRef.current = moment
    schrijfActiviteit(moment)
    meet()
  }, [meet])

  const zetLangeSessie = useCallback(
    (aan: boolean) => {
      if (!uid) return
      langRef.current = aan
      schrijfLangeSessie(uid, aan)
      // Ook bij het UITzetten de teller terugzetten. Wie een uur lang niets
      // deed met de lange sessie aan, zou anders bij het uitzetten meteen
      // afgemeld worden -- alsof de knop je buiten gooit.
      const moment = Date.now()
      activiteitRef.current = moment
      schrijfActiviteit(moment)
      meet()
    },
    [uid, meet]
  )

  return {
    stand: oordeel.stand,
    reden: oordeel.reden,
    secondenResterend: oordeel.secondenResterend,
    blijfAangemeld,
    langeSessie: peiling.lang,
    zetLangeSessie,
    eindeSessie: peiling.start === null ? null : eindeVanDeSessie(peiling.start),
  }
}
