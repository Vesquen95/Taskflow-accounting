import { useEffect, useMemo, useRef, useState } from 'react'
import { Reactor } from './Reactor'
import { supabase } from '../lib/supabase'
import { isoDatum } from '../lib/werkstromen'
import { speelIntro, speelIntroBestand, type Afspelend } from '../lib/geluid'
import { BEGROETING, leesGeluid, wisBegroeting } from '../lib/begroeting'
import {
  bewaarVorigCitaat,
  kiesCitaat,
  leesVorigCitaat,
  toelichting,
  type Citaat,
  type Stand,
} from '../lib/citaten'

const DUUR_MS = 5200
/** Met het eigen intronummer blijft de begroeting zo lang als het nummer, tot hier. */
const MAX_DUUR_MS = 11_000
const UITFADEN_MS = 500
/** Zo lang wacht het citaat op de telling; daarna kiest het zonder. */
const WACHT_OP_STAND_MS = 700

const LOPEND = ['open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring']

/** Hoeveel taken van deze medewerker te laat zijn, en hoeveel er deze week vallen. */
async function haalStand(medewerkerId: string): Promise<Stand> {
  const vandaag = new Date()
  const overZeven = new Date(vandaag)
  overZeven.setDate(vandaag.getDate() + 6)
  const tel = () =>
    supabase
      .from('task_instances')
      .select('id', { count: 'exact', head: true })
      .eq('toegewezen_medewerker_id', medewerkerId)
      .in('status', LOPEND)
  const [laat, week] = await Promise.all([
    tel().lt('due_date', isoDatum(vandaag)),
    tel().gte('due_date', isoDatum(vandaag)).lte('due_date', isoDatum(overZeven)),
  ])
  if (laat.error || week.error) throw laat.error ?? week.error
  return { achterstand: laat.count ?? 0, dezeWeek: week.count ?? 0 }
}

/** Wacht op de telling, maar niet langer dan `ms`: dan zonder. */
function binnen<T>(belofte: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    belofte.catch(() => null),
    new Promise<null>((klaar) => window.setTimeout(() => klaar(null), ms)),
  ])
}

/**
 * Het moment na het inloggen: de reactor vergrendelt, "Toegang verleend",
 * dezelfde woorden als de stem in het intronummer -- "Good day, sir. I am
 * ready to assist you. Systems are now fully operational." -- en een
 * filmcitaat dat bij het moment past (lib/citaten.ts). Met het geluid aan het intronummer uit Suno,
 * of als dat niet laadt het opgewekte muziekje (lib/geluid.ts).
 *
 * Kort: wie wil werken, klikt of drukt een toets en is er meteen. Zie
 * lib/begroeting.ts voor waarom dit niet op het inlogscherm zelf kan.
 */
export function Begroeting({ medewerkerId, onKlaar }: { medewerkerId: string; onKlaar: () => void }) {
  const nu = useMemo(() => new Date(), [])
  const [citaat, setCitaat] = useState<{ citaat: Citaat; stand: Stand | null } | null>(null)
  const [weg, setWeg] = useState(false)
  const [duur, setDuur] = useState(DUUR_MS)
  const nummer = useRef<Afspelend | null>(null)

  useEffect(() => {
    wisBegroeting()
    const geluid = leesGeluid()
    let actief = true
    // Het intronummer; lukt dat niet, dan het opgewekte muziekje.
    const intro: Promise<Afspelend | null> = geluid ? speelIntroBestand() : Promise.resolve(null)
    void intro.then((afspelend) => {
      if (!actief) return afspelend?.stop()
      if (afspelend) {
        nummer.current = afspelend
        setDuur(Math.min(MAX_DUUR_MS, Math.max(DUUR_MS, afspelend.duur * 1000)))
      } else if (geluid) speelIntro()
    })
    void binnen(haalStand(medewerkerId), WACHT_OP_STAND_MS).then((stand) => {
      if (!actief) return
      const gekozen = kiesCitaat(nu.getHours(), stand, leesVorigCitaat(), Math.random())
      bewaarVorigCitaat(gekozen.id)
      setCitaat({ citaat: gekozen, stand })
    })
    return () => {
      actief = false
      nummer.current?.stop()
    }
    // Eén keer, bij het verschijnen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // De duur kan nog groeien als het nummer langer is dan de begroeting.
  useEffect(() => {
    const uit = window.setTimeout(() => setWeg(true), duur - UITFADEN_MS)
    const klaar = window.setTimeout(onKlaar, duur)
    return () => {
      window.clearTimeout(uit)
      window.clearTimeout(klaar)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duur])

  useEffect(() => {
    const sluit = () => onKlaar()
    window.addEventListener('keydown', sluit)
    return () => window.removeEventListener('keydown', sluit)
  }, [onKlaar])

  const uitleg = citaat && toelichting(citaat.citaat, citaat.stand)

  return (
    <div
      onClick={onKlaar}
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-[#070C0B]/95 px-4 text-center backdrop-blur-sm transition-opacity duration-500 ${weg ? 'opacity-0' : 'opacity-100'}`}
    >
      <div className="relative aspect-square w-[min(56vw,240px)]">
        <Reactor nu={nu} toerental="vergrendeld" />
      </div>
      <div role="status" className="max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-[#3EF0D2] motion-safe:animate-opstart">
          Toegang verleend
        </p>
        <p
          className="mt-2 text-3xl font-light tracking-[0.04em] text-[#FFFFFF] motion-safe:animate-opstart md:text-4xl"
          style={{ animationDelay: '0.25s' }}
        >
          {BEGROETING.groet}
        </p>
        {BEGROETING.regels.map((regel, i) => (
          <p
            key={regel}
            className="mt-2 text-base text-[#BFEFFF] motion-safe:animate-opstart md:text-lg"
            style={{ animationDelay: `${0.9 + i * 0.7}s` }}
          >
            {regel}
          </p>
        ))}
        {citaat && (
          <figure className="mx-auto mt-8 max-w-xl border-t border-[#7FDBFF]/20 pt-6 motion-safe:animate-opstart">
            <blockquote className="text-xl font-light italic leading-snug text-[#BFEFFF] md:text-2xl">
              “{citaat.citaat.tekst}”
            </blockquote>
            <figcaption className="mt-2 font-mono text-[11px] uppercase tracking-[0.25em] text-[#4F7682]">
              {citaat.citaat.bron}
            </figcaption>
            {uitleg && <p className="mt-3 text-sm text-[#FFB547]">{uitleg}</p>}
          </figure>
        )}
      </div>
    </div>
  )
}
