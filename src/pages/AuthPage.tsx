import { useEffect, useMemo, useState, type FormEvent } from 'react'
import '@fontsource-variable/atkinson-hyperlegible-mono'
import { useAuth } from '../hooks/useAuth'
import { VERLOOP_UITLEG } from '../lib/sessieduur'
import { leesVerloopreden, wisVerloopreden } from '../lib/sessieopslag'
import { dagVanHetJaar, isoWeek, volgendeBtwKwartaal } from '../lib/inlogscherm'

/**
 * Het inlogscherm: het jaar als wijzerplaat.
 *
 * Gevraagd (14/10/2026): "mega futuristisch". Gekozen uit drie voorstellen:
 * de chronometer (B) met de opstartreeks en de uitlezingen van de terminal
 * (C). Het idee blijft dat van de app: termijnen komen op je af. De ring is
 * het jaar, de boog loopt van vandaag naar de volgende btw-kwartaaltermijn.
 *
 * Wat bleef zoals het was: het formulier zelf (één knop erin, registreren
 * erbuiten), de foutmeldingen, en de uitleg na een automatische afmelding.
 * Alleen die meldingen kondigen zich aan als status; de decoratie zwijgt voor
 * een schermlezer.
 */

const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

/** Graden op de wijzerplaat: 1 januari bovenaan, met de klok mee. */
function hoek(dag: number, dagenInJaar: number) {
  return (dag / dagenInJaar) * 2 * Math.PI - Math.PI / 2
}
function punt(a: number, r: number): [number, number] {
  return [Math.cos(a) * r, Math.sin(a) * r]
}

function Wijzerplaat({ nu }: { nu: Date }) {
  const jaar = nu.getFullYear()
  const dagenInJaar = dagVanHetJaar(new Date(jaar, 11, 31)) + 1
  const vandaag = dagVanHetJaar(nu)
  const termijn = volgendeBtwKwartaal(nu)
  // Een termijn in januari ligt in het volgende jaar: de boog loopt dan door
  // over de top van de ring.
  const termijnDag = vandaag + termijn.dagen
  const [ax, ay] = punt(hoek(vandaag, dagenInJaar), 190)
  const [bx, by] = punt(hoek(termijnDag, dagenInJaar), 190)
  const groteBoog = termijn.dagen > dagenInJaar / 2 ? 1 : 0

  return (
    <svg viewBox="-200 -200 400 400" aria-hidden="true" className="absolute inset-0 h-full w-full overflow-visible">
      <defs>
        <linearGradient id="tf-boog" x1="0" x2="1">
          <stop offset="0" stopColor="#3EF0D2" />
          <stop offset="1" stopColor="#FFB547" />
        </linearGradient>
        <filter id="tf-gloed">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle r="190" fill="none" stroke="#1B2725" />
      <circle r="168" fill="none" stroke="#1B2725" />
      <g className="origin-center motion-safe:animate-draai">
        <circle r="181" fill="none" stroke="#2A3A37" strokeDasharray="1 5" />
      </g>
      {Array.from({ length: 53 }, (_, w) => {
        const a = hoek(w * 7, dagenInJaar)
        const [x1, y1] = punt(a, 168)
        const [x2, y2] = punt(a, w % 4 === 0 ? 177 : 173)
        return <line key={w} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3A4D49" />
      })}
      {MAANDEN.map((m, i) => {
        const midden = dagVanHetJaar(new Date(jaar, i, 15))
        const [x, y] = punt(hoek(midden, dagenInJaar), 152)
        const huidig = i === nu.getMonth()
        return (
          <text
            key={m}
            x={x}
            y={y + 3}
            textAnchor="middle"
            fontSize="9"
            letterSpacing="1.5"
            className="font-mono uppercase"
            fill={huidig ? '#E8F5F1' : '#5C7A73'}
          >
            {m}
          </text>
        )
      })}
      <path
        d={`M${ax} ${ay} A190 190 0 ${groteBoog} 1 ${bx} ${by}`}
        fill="none"
        stroke="url(#tf-boog)"
        strokeWidth="4"
        strokeLinecap="round"
        filter="url(#tf-gloed)"
      />
      <circle cx={ax} cy={ay} r="5" fill="#3EF0D2" filter="url(#tf-gloed)" />
      <circle cx={bx} cy={by} r="6" fill="#070C0B" stroke="#FFB547" strokeWidth="2" filter="url(#tf-gloed)" />
    </svg>
  )
}

/** De vier hoeken van het scherm: het kader van een vizier. */
function Hoeken() {
  const basis = 'pointer-events-none fixed h-6 w-6 border-[#3EF0D2]/70'
  return (
    <div aria-hidden="true">
      <span className={`${basis} left-4 top-4 border-l-2 border-t-2`} />
      <span className={`${basis} right-4 top-4 border-r-2 border-t-2`} />
      <span className={`${basis} bottom-4 left-4 border-b-2 border-l-2`} />
      <span className={`${basis} bottom-4 right-4 border-b-2 border-r-2`} />
    </div>
  )
}

const OPSTART = ['taskflow gestart', 'verbinding versleuteld', 'kalender van het jaar klaar']

export function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
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

  function wisselModus(nieuw: 'signin' | 'signup') {
    setMode(nieuw)
    setError(null)
    setInfo(null)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setSubmitting(true)
    try {
      if (mode === 'signin') {
        const { error: err } = await signIn(email, password)
        if (err) setError(err)
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
    'w-full rounded-full border border-[#2A3A37] bg-[#0A1211]/90 px-5 py-2.5 text-center text-[15px] text-[#FFFFFF] placeholder:text-[#5C7A73] focus:border-[#3EF0D2] focus:outline-none focus-visible:shadow-[0_0_18px_rgba(62,240,210,0.35)]'

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden xl:h-screen xl:min-h-[640px] bg-[#070C0B] text-[#C9D6D2] [background-image:radial-gradient(circle_at_50%_45%,#0F1C1A_0%,#070C0B_60%)]">
      {/* Raster en scanlijnen: decor, achter alles. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-40 [background-image:linear-gradient(#0F2B28_1px,transparent_1px),linear-gradient(90deg,#0F2B28_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(circle_at_50%_45%,transparent_30%,#000_75%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-20 [background-image:repeating-linear-gradient(to_bottom,rgba(62,240,210,0.03)_0_1px,transparent_1px_3px)]"
      />
      <Hoeken />

      {/* De opstartreeks: één moment bij het laden, dan rust. */}
      <div aria-hidden="true" className="absolute left-10 top-10 z-10 hidden font-mono text-xs leading-6 text-[#5C7A73] md:block">
        {OPSTART.map((regel, i) => (
          <p key={regel} className="motion-safe:animate-opstart" style={{ animationDelay: `${i * 0.35}s` }}>
            &gt; {regel} <span className="text-[#3EF0D2]">OK</span>
          </p>
        ))}
        <p className="motion-safe:animate-opstart" style={{ animationDelay: `${OPSTART.length * 0.35}s` }}>
          &gt; wacht op aanmelding{' '}
          <span className="inline-block h-3.5 w-2 translate-y-0.5 bg-[#3EF0D2] motion-safe:animate-knipper" />
        </p>
      </div>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-8 md:py-6">
        <div className="relative aspect-square w-[min(128vw,520px)] shrink-0 md:w-[min(70vh,600px)] xl:w-[min(86vh,680px)]">
          <Wijzerplaat nu={nu} />

          <div className="absolute inset-x-[17%] inset-y-[14%] flex flex-col items-stretch justify-center text-center md:inset-[23%]">
            <img
              src={`${import.meta.env.BASE_URL}pato-logo.svg`}
              alt="PATO Accountancy"
              className="mx-auto mb-3 h-12 w-auto md:mb-4 md:h-16"
            />
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#8FA39D]">
              {nu.toLocaleDateString('nl-BE', { weekday: 'long' })}{' '}
              {nu.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.')}
            </p>
            <h1 className="mt-1 text-4xl font-light tracking-[0.06em] text-[#FFFFFF] md:text-5xl">Taskflow</h1>
            <p className="mb-4 mt-1 text-sm text-[#FFB547] md:mb-5">
              Btw {termijn.kwartaal} {termijnTekst}
            </p>

            {verloopreden && (
              <p role="status" className="mb-3 rounded-2xl border border-[#FFB547]/40 bg-[#FFB547]/10 px-4 py-2 text-sm text-[#FFD9A0]">
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
                <p role="alert" className="rounded-2xl border border-[#FF6B5E]/40 bg-[#FF6B5E]/10 px-4 py-2 text-sm text-[#FFB3AA]">
                  {error}
                </p>
              )}
              {info && (
                <p role="status" className="rounded-2xl border border-[#3EF0D2]/40 bg-[#3EF0D2]/10 px-4 py-2 text-sm text-[#B5FFF1]">
                  {info}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-2 w-full rounded-full border border-[#3EF0D2] bg-[#3EF0D2]/10 px-4 py-3 text-sm font-bold tracking-[0.12em] text-[#3EF0D2] shadow-[inset_0_0_24px_rgba(62,240,210,0.25)] transition hover:bg-[#3EF0D2] hover:text-[#04201C] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3EF0D2] focus-visible:ring-offset-2 focus-visible:ring-offset-[#070C0B] disabled:opacity-60"
              >
                {submitting ? 'Bezig…' : mode === 'signin' ? 'Inloggen' : 'Account aanmaken'}
              </button>
            </form>

            <p className="mt-3 text-xs text-[#8FA39D]">
              {mode === 'signin' ? 'Nog geen account?' : 'Al een account?'}{' '}
              <button
                type="button"
                onClick={() => wisselModus(mode === 'signin' ? 'signup' : 'signin')}
                className="font-semibold text-[#E8F5F1] underline underline-offset-2 hover:text-[#3EF0D2]"
              >
                {mode === 'signin' ? 'Registreren' : 'Inloggen'}
              </button>
            </p>
          </div>
        </div>
      </main>

      {/* De uitlezingen: wat de wijzerplaat toont, in cijfers. */}
      <dl className="relative z-10 mx-auto mb-8 grid w-full max-w-md grid-cols-3 gap-2 px-4 font-mono xl:absolute xl:bottom-10 xl:right-10 xl:mb-0 xl:w-52 xl:grid-cols-1 xl:gap-3 xl:px-0">
        <div className="border border-[#16302C] bg-[#0A1211]/70 px-3 py-2 md:px-4 md:py-3">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#8FA39D]">Vandaag</dt>
          <dd className="mt-1 text-base text-[#FFFFFF] md:text-xl">
            {nu.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit' }).replace(/\//g, '.')}
          </dd>
        </div>
        <div className="border border-[#16302C] bg-[#0A1211]/70 px-3 py-2 md:px-4 md:py-3">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#8FA39D]">Week</dt>
          <dd className="mt-1 text-base text-[#FFFFFF] md:text-xl">{isoWeek(nu)}</dd>
        </div>
        <div className="border border-[#16302C] bg-[#0A1211]/70 px-3 py-2 md:px-4 md:py-3">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#8FA39D]">Btw {termijn.kwartaal}</dt>
          <dd className="mt-1 text-base text-[#FFB547] md:text-xl" title={`Wettelijke termijn: ${termijnDatum}`}>
            {termijn.dagen === 0 ? 'vandaag' : `${termijn.dagen} d`}
          </dd>
        </div>
      </dl>
    </div>
  )
}
