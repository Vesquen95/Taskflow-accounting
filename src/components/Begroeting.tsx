import { useEffect, useMemo, useState } from 'react'
import { Reactor } from './Reactor'
import { groet, leesStem, spreek, voornaam, wisBegroeting } from '../lib/begroeting'

const DUUR_MS = 2600
const UITFADEN_MS = 500

/**
 * Het moment na het inloggen: de reactor vergrendelt, "Toegang verleend",
 * en een groet bij naam. Kort -- wie wil werken, klikt of drukt een toets en
 * is er meteen. Zie lib/begroeting.ts voor waarom dit niet op het
 * inlogscherm zelf kan.
 */
export function Begroeting({ naam, onKlaar }: { naam: string; onKlaar: () => void }) {
  const nu = useMemo(() => new Date(), [])
  const tekst = `${groet(nu.getHours())}, ${voornaam(naam)}.`
  const [weg, setWeg] = useState(false)

  useEffect(() => {
    wisBegroeting()
    if (leesStem()) spreek(`${tekst} Welkom terug in Taskflow.`)
    const uit = window.setTimeout(() => setWeg(true), DUUR_MS - UITFADEN_MS)
    const klaar = window.setTimeout(onKlaar, DUUR_MS)
    return () => {
      window.clearTimeout(uit)
      window.clearTimeout(klaar)
    }
    // Eén keer, bij het verschijnen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const sluit = () => onKlaar()
    window.addEventListener('keydown', sluit)
    return () => window.removeEventListener('keydown', sluit)
  }, [onKlaar])

  return (
    <div
      onClick={onKlaar}
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-[#070C0B]/95 px-4 text-center backdrop-blur-sm transition-opacity duration-500 ${weg ? 'opacity-0' : 'opacity-100'}`}
    >
      <div className="relative aspect-square w-[min(60vw,260px)]">
        <Reactor nu={nu} toerental="vergrendeld" />
      </div>
      <div role="status">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-[#3EF0D2] motion-safe:animate-opstart">
          Toegang verleend
        </p>
        <p
          className="mt-2 text-3xl font-light tracking-[0.04em] text-[#FFFFFF] motion-safe:animate-opstart md:text-4xl"
          style={{ animationDelay: '0.25s' }}
        >
          {tekst}
        </p>
      </div>
    </div>
  )
}
