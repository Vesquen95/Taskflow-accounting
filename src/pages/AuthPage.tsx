import { useEffect, useMemo, useState, type FormEvent } from 'react'
import '@fontsource-variable/atkinson-hyperlegible-mono'
import { useAuth } from '../hooks/useAuth'
import { VERLOOP_UITLEG } from '../lib/sessieduur'
import { leesVerloopreden, wisVerloopreden } from '../lib/sessieopslag'
import { dagVanHetJaar, isoWeek, volgendeBtwKwartaal } from '../lib/inlogscherm'
import {
  AANSPREKINGEN,
  bewaarAanspreking,
  bewaarStem,
  kanSpreken,
  leesAanspreking,
  leesStem,
  markeerBegroeting,
  spreek,
  wisBegroeting,
  type Aanspreking,
} from '../lib/begroeting'
import { Reactor } from '../components/Reactor'

/**
 * Het inlogscherm: de reactor.
 *
 * Gevraagd (23/10/2026): "zoals Jarvis van Iron Man". Links praat de
 * assistent -- P.A.T.O., Persoonlijke Assistent voor Taken en Opvolging --
 * in het midden draait de reactor (components/Reactor.tsx), rechts het
 * identificatiepaneel. Bij het aanmelden draait de reactor op toeren; na het
 * inloggen volgt de begroeting bij naam (components/Begroeting.tsx), als je
 * wil ook gesproken.
 *
 * Wat bleef zoals het was: het formulier zelf (één knop erin, registreren
 * erbuiten), de foutmeldingen, en de uitleg na een automatische afmelding.
 * Alleen die meldingen kondigen zich aan als status; de decoratie zwijgt voor
 * een schermlezer.
 */

/** De vier hoeken van een vizier: rond het scherm, of rond een paneel. */
const HOEKEN = {
  scherm: [
    'fixed left-4 top-4 border-l-2 border-t-2',
    'fixed right-4 top-4 border-r-2 border-t-2',
    'fixed bottom-4 left-4 border-b-2 border-l-2',
    'fixed bottom-4 right-4 border-b-2 border-r-2',
  ],
  paneel: [
    'absolute -left-px -top-px border-l-2 border-t-2',
    'absolute -right-px -top-px border-r-2 border-t-2',
    'absolute -bottom-px -left-px border-b-2 border-l-2',
    'absolute -bottom-px -right-px border-b-2 border-r-2',
  ],
}
function Hoeken({ rond }: { rond: keyof typeof HOEKEN }) {
  return (
    <div aria-hidden="true">
      {HOEKEN[rond].map((plaats) => (
        <span key={plaats} className={`pointer-events-none h-4 w-4 border-[#7FDBFF]/70 ${plaats}`} />
      ))}
    </div>
  )
}

/** Eén regel van de assistent, die zich teken per teken uittypt. */
function Logregel({ tekst, vertraging, ok = false }: { tekst: string; vertraging: number; ok?: boolean }) {
  return (
    <p className="whitespace-nowrap">
      <span className="text-[#4F7682]">&gt; </span>
      <span
        className="inline-block overflow-hidden whitespace-nowrap align-bottom motion-safe:animate-typ"
        style={{
          width: `${tekst.length}ch`,
          animationDuration: `${tekst.length * 0.022}s`,
          animationTimingFunction: `steps(${tekst.length})`,
          animationDelay: `${vertraging}s`,
        }}
      >
        {tekst}
      </span>
      {ok && (
        <span className="motion-safe:animate-opstart" style={{ animationDelay: `${vertraging + tekst.length * 0.022}s` }}>
          {' '}
          <span className="text-[#3EF0D2]">OK</span>
        </span>
      )}
    </p>
  )
}

export function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Alleen tonen als de browser kan spreken.
  const [spraak] = useState(kanSpreken)
  const [stem, setStem] = useState(leesStem)
  const [aanspreking, setAanspreking] = useState(leesAanspreking)
  // Wie automatisch afgemeld werd, staat hier zonder te weten waarom. Zonder
  // uitleg leest dat als een storing.
  const [verloopreden] = useState(() => leesVerloopreden())
  useEffect(() => {
    wisVerloopreden()
  }, [])

  // Eén keer per bezoek: het scherm hoort niet van datum te wisselen terwijl
  // iemand zijn wachtwoord typt.
  const nu = useMemo(() => new Date(), [])
  const termijn = useMemo(() => volgendeBtwKwartaal(nu), [nu])
  const termijnTekst =
    termijn.dagen === 0 ? 'vandaag' : termijn.dagen === 1 ? 'morgen' : `over ${termijn.dagen} dagen`
  const termijnDatum = new Date(`${termijn.datum}T00:00:00`).toLocaleDateString('nl-BE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  // Wat de assistent zegt: alleen wat zeker is zonder databank.
  const log = [
    { tekst: 'verbinding versleuteld', ok: true },
    { tekst: 'wettelijke kalender geladen', ok: true },
    { tekst: `week ${isoWeek(nu)}, dag ${dagVanHetJaar(nu) + 1} van ${nu.getFullYear()}` },
    { tekst: `volgende btw-termijn: ${termijn.kwartaal}, ${termijnDatum}` },
  ]
  let vertraging = 0.3
  const regels = log.map((regel) => {
    const r = { ...regel, vertraging }
    vertraging += regel.tekst.length * 0.022 + 0.25
    return r
  })

  function wisselModus(nieuw: 'signin' | 'signup') {
    setMode(nieuw)
    setError(null)
    setInfo(null)
  }

  function wisselStem() {
    const aan = !stem
    setStem(aan)
    bewaarStem(aan)
    if (aan) spreek('Voice interface online.')
  }

  function kiesAanspreking(nieuw: Aanspreking) {
    setAanspreking(nieuw)
    bewaarAanspreking(nieuw)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setSubmitting(true)
    try {
      if (mode === 'signin') {
        // Vóór het aanmelden: de app neemt het over zodra de sessie er is.
        markeerBegroeting()
        const { error: err } = await signIn(email, password)
        if (err) {
          wisBegroeting()
          setError(err)
        }
      } else {
        const { error: err } = await signUp(email, password)
        if (err) {
          setError(err)
        } else {
          setInfo('Account aangemaakt. Check je e-mail als bevestiging vereist is, of log direct in.')
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  const veld =
    'w-full rounded-sm border border-[#1F3E48] bg-[#060E12]/90 px-4 py-2.5 text-[15px] text-[#FFFFFF] placeholder:text-[#4F7682] focus:border-[#7FDBFF] focus:outline-none focus-visible:shadow-[0_0_18px_rgba(127,219,255,0.3)]'

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#070C0B] text-[#C9D6D2] [background-image:radial-gradient(circle_at_50%_45%,#0C1A1F_0%,#070C0B_60%)] xl:h-screen xl:min-h-[680px]">
      {/* Raster en scanlijnen: decor, achter alles. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-40 [background-image:linear-gradient(#0E2A33_1px,transparent_1px),linear-gradient(90deg,#0E2A33_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(circle_at_50%_45%,transparent_30%,#000_75%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-20 [background-image:repeating-linear-gradient(to_bottom,rgba(127,219,255,0.03)_0_1px,transparent_1px_3px)]"
      />
      <Hoeken rond="scherm" />

      {/* De assistent: één keer bij het laden, dan wacht hij. */}
      <div aria-hidden="true" className="absolute left-12 top-10 z-10 hidden font-mono text-xs leading-6 text-[#86A3AD] xl:block">
        <p className="text-[10px] uppercase tracking-[0.3em] text-[#4F7682]">Persoonlijke Assistent voor Taken en Opvolging</p>
        <p className="mb-2 text-2xl font-light tracking-[0.2em] text-[#E9FDFF] motion-safe:animate-opstart">
          P.A.T.O. <span className="text-xs tracking-[0.2em] text-[#3EF0D2]">online</span>
        </p>
        {regels.map((r) => (
          <Logregel key={r.tekst} tekst={r.tekst} vertraging={r.vertraging} ok={r.ok} />
        ))}
        <p className="motion-safe:animate-opstart" style={{ animationDelay: `${vertraging}s` }}>
          <span className="text-[#4F7682]">&gt; </span>
          {submitting ? 'identificatie loopt' : 'identificatie vereist'}{' '}
          <span className="inline-block h-3.5 w-2 translate-y-0.5 bg-[#7FDBFF] motion-safe:animate-knipper" />
        </p>
      </div>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-6 px-4 py-8 lg:flex-row lg:gap-16 xl:pl-40">
        <div className="relative aspect-square w-[min(66vw,280px)] shrink-0 lg:w-[min(64vh,540px)]">
          <Reactor nu={nu} toerental={submitting ? 'scan' : 'rust'} opstart />
        </div>

        <section className="relative w-full max-w-sm border border-[#7FDBFF]/20 bg-[#071116]/85 px-6 py-6 backdrop-blur-sm">
          <Hoeken rond="paneel" />
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-[#7FDBFF]">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#3EF0D2] motion-safe:animate-pulseer" />
            Identificatie
          </p>
          <img
            src={`${import.meta.env.BASE_URL}pato-logo.svg`}
            alt="PATO Accountancy"
            className="mb-2 mt-4 h-10 w-auto"
          />
          <h1 className="text-4xl font-light tracking-[0.06em] text-[#FFFFFF]">Taskflow</h1>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-[#86A3AD]">
            {nu.toLocaleDateString('nl-BE', { weekday: 'long' })}{' '}
            {nu.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.')}
          </p>
          <p className="mb-5 mt-1 text-sm text-[#FFB547]">
            Btw {termijn.kwartaal} {termijnTekst}
          </p>

          {verloopreden && (
            <p role="status" className="mb-3 rounded-sm border border-[#FFB547]/40 bg-[#FFB547]/10 px-4 py-2 text-sm text-[#FFD9A0]">
              {VERLOOP_UITLEG[verloopreden]}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-2.5">
            <label htmlFor="email" className="sr-only">
              E-mailadres
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="E-mailadres"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={veld}
            />
            <label htmlFor="password" className="sr-only">
              Wachtwoord
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              placeholder="Wachtwoord"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={veld}
            />

            {error && (
              <p role="alert" className="rounded-sm border border-[#FF6B5E]/40 bg-[#FF6B5E]/10 px-4 py-2 text-sm text-[#FFB3AA]">
                {error}
              </p>
            )}
            {info && (
              <p role="status" className="rounded-sm border border-[#3EF0D2]/40 bg-[#3EF0D2]/10 px-4 py-2 text-sm text-[#B5FFF1]">
                {info}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-sm border border-[#7FDBFF] bg-[#7FDBFF]/10 px-4 py-3 text-sm font-bold tracking-[0.18em] text-[#BFEFFF] shadow-[inset_0_0_24px_rgba(127,219,255,0.2)] transition hover:bg-[#7FDBFF] hover:text-[#04161C] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7FDBFF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#070C0B] disabled:opacity-60"
            >
              {submitting ? 'Bezig…' : mode === 'signin' ? 'Inloggen' : 'Account aanmaken'}
            </button>
          </form>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-[#86A3AD]">
            <p>
              {mode === 'signin' ? 'Nog geen account?' : 'Al een account?'}{' '}
              <button
                type="button"
                onClick={() => wisselModus(mode === 'signin' ? 'signup' : 'signin')}
                className="font-semibold text-[#E9FDFF] underline underline-offset-2 hover:text-[#7FDBFF]"
              >
                {mode === 'signin' ? 'Registreren' : 'Inloggen'}
              </button>
            </p>
            {spraak && (
              <button
                type="button"
                aria-pressed={stem}
                onClick={wisselStem}
                className="font-mono uppercase tracking-[0.15em] hover:text-[#7FDBFF]"
              >
                Stem: <span className={stem ? 'text-[#3EF0D2]' : 'text-[#4F7682]'}>{stem ? 'aan' : 'uit'}</span>
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center justify-end gap-2 font-mono text-xs uppercase tracking-[0.15em] text-[#86A3AD]">
            <label htmlFor="aanspreking">Aanspreking</label>
            <select
              id="aanspreking"
              value={aanspreking}
              onChange={(e) => kiesAanspreking(e.target.value as Aanspreking)}
              className="rounded-sm border border-[#1F3E48] bg-[#060E12] px-2 py-1 font-mono text-xs text-[#E9FDFF] focus:border-[#7FDBFF] focus:outline-none"
            >
              {AANSPREKINGEN.map((a) => (
                <option key={a.waarde} value={a.waarde}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        </section>
      </main>

      {/* De uitlezingen: wat de jaarring toont, in cijfers. */}
      <dl className="relative z-10 mx-auto mb-8 grid w-full max-w-sm grid-cols-3 gap-2 px-4 font-mono xl:absolute xl:bottom-10 xl:left-12 xl:mb-0 xl:w-[26rem] xl:max-w-none xl:px-0">
        <div className="border border-[#14303A] bg-[#071116]/70 px-3 py-2 md:px-4 md:py-3">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#86A3AD]">Vandaag</dt>
          <dd className="mt-1 text-base text-[#FFFFFF] md:text-xl">
            {nu.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit' }).replace(/\//g, '.')}
          </dd>
        </div>
        <div className="border border-[#14303A] bg-[#071116]/70 px-3 py-2 md:px-4 md:py-3">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#86A3AD]">Week</dt>
          <dd className="mt-1 text-base text-[#FFFFFF] md:text-xl">{isoWeek(nu)}</dd>
        </div>
        <div className="border border-[#14303A] bg-[#071116]/70 px-3 py-2 md:px-4 md:py-3">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#86A3AD]">Btw {termijn.kwartaal}</dt>
          <dd className="mt-1 text-base text-[#FFB547] md:text-xl" title={`Wettelijke termijn: ${termijnDatum}`}>
            {termijn.dagen === 0 ? 'vandaag' : `${termijn.dagen} d`}
          </dd>
        </div>
      </dl>
    </div>
  )
}
