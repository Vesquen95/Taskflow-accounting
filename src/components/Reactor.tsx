import { useId, type ReactNode } from 'react'
import { dagVanHetJaar, volgendeBtwKwartaal } from '../lib/inlogscherm'

/**
 * De reactor: het hart van het inlogscherm en van de begroeting erna.
 *
 * Gevraagd (23/10/2026): het inlogscherm "zoals Jarvis van Iron Man". Ringen
 * die elk op hun eigen tempo draaien, een scanlijn, en in de kern het teken
 * van PATO -- de Λ is toevallig ook de vorm van een reactorkern.
 *
 * De buitenste ring is niet alleen decor: dat is het jaar, zoals de
 * wijzerplaat ervoor. De boog loopt van vandaag naar de volgende
 * btw-kwartaaltermijn.
 *
 * Drie toerentallen: `rust` (wachten), `scan` (er wordt aangemeld: alles
 * draait sneller) en `vergrendeld` (toegang verleend: de ringen staan stil en
 * een golf loopt naar buiten). Alle beweging staat achter motion-safe.
 *
 * Met `opstart` komt de reactor bij het laden tot leven, in ruim twee
 * seconden: een vonk in de kern, de ringen die van binnen naar buiten op
 * toeren komen, een schokgolf, de weken van het jaar die rondlopen, de Λ die
 * zichzelf tekent en als laatste de boog naar de btw-termijn.
 */

export type Toerental = 'rust' | 'scan' | 'vergrendeld'

const IJS = '#7FDBFF'
const PETROL = '#3EF0D2'
const PAARS = '#B57BFF'
const AMBER = '#FFB547'
const LIJN = '#16323A'

// Een SVG-element draait standaard rond de oorsprong van het assenstelsel van
// de viewBox, niet rond zijn eigen middelpunt. Hier ligt (0, 0) in het
// midden van de reactor (viewBox -200 -200 400 400), dus: daar.
const MIDDEN = '0px 0px'

const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

/** Graden op de jaarring: 1 januari bovenaan, met de klok mee. */
function hoek(dag: number, dagenInJaar: number) {
  return (dag / dagenInJaar) * 2 * Math.PI - Math.PI / 2
}
function punt(a: number, r: number): [number, number] {
  return [Math.cos(a) * r, Math.sin(a) * r]
}

function Draaiend({
  duur,
  terug = false,
  toerental,
  children,
}: {
  duur: number
  terug?: boolean
  toerental: Toerental
  children: ReactNode
}) {
  return (
    <g
      className="motion-safe:animate-draai"
      style={{
        transformOrigin: MIDDEN,
        animationDuration: `${toerental === 'scan' ? duur / 8 : duur}s`,
        animationDirection: terug ? 'reverse' : 'normal',
        animationPlayState: toerental === 'vergrendeld' ? 'paused' : 'running',
      }}
    >
      {children}
    </g>
  )
}

/** Een ring die bij de opstart van klein en draaiend op zijn plaats komt. */
function Ontsteek({ aan, na, children }: { aan: boolean; na: number; children: ReactNode }) {
  if (!aan) return <>{children}</>
  return (
    <g className="motion-safe:animate-ontsteek" style={{ transformOrigin: MIDDEN, animationDelay: `${na}s` }}>
      {children}
    </g>
  )
}

/** Verschijnt bij de opstart na `na` seconden; anders gewoon. */
function verschijn(aan: boolean, na: number) {
  return aan ? { className: 'motion-safe:animate-verschijn', style: { animationDelay: `${na}s` } } : {}
}

/** Een lijn die zichzelf tekent: pathLength 1, het streepje schuift erin. */
function teken(aan: boolean, na: number) {
  return aan
    ? { pathLength: 1, strokeDasharray: 1, className: 'motion-safe:animate-teken', style: { animationDelay: `${na}s` } }
    : {}
}

/** De buitenste ring: het jaar, met de boog naar de volgende btw-termijn. */
function Jaarring({ nu, opstart }: { nu: Date; opstart: boolean }) {
  const id = useId()
  const jaar = nu.getFullYear()
  const dagenInJaar = dagVanHetJaar(new Date(jaar, 11, 31)) + 1
  const vandaag = dagVanHetJaar(nu)
  const termijn = volgendeBtwKwartaal(nu)
  // Een termijn in januari ligt in het volgende jaar: de boog loopt dan door
  // over de top van de ring.
  const [ax, ay] = punt(hoek(vandaag, dagenInJaar), 190)
  const [bx, by] = punt(hoek(vandaag + termijn.dagen, dagenInJaar), 190)
  const groteBoog = termijn.dagen > dagenInJaar / 2 ? 1 : 0

  return (
    <g>
      <defs>
        <linearGradient id={`${id}boog`} x1="0" x2="1">
          <stop offset="0" stopColor={PETROL} />
          <stop offset="1" stopColor={AMBER} />
        </linearGradient>
      </defs>
      <circle r="190" fill="none" stroke={LIJN} {...verschijn(opstart, 0.6)} />
      {/* De weken lopen bij de opstart rond, van januari tot december. */}
      {Array.from({ length: 53 }, (_, w) => {
        const a = hoek(w * 7, dagenInJaar)
        const [x1, y1] = punt(a, 180)
        const [x2, y2] = punt(a, w % 4 === 0 ? 188 : 184)
        return (
          <line key={w} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2B4B55" {...verschijn(opstart, 0.7 + w * 0.016)} />
        )
      })}
      {MAANDEN.map((m, i) => {
        const [x, y] = punt(hoek(dagVanHetJaar(new Date(jaar, i, 15)), dagenInJaar), 169)
        return (
          <text
            key={m}
            x={x}
            y={y + 3}
            textAnchor="middle"
            fontSize="8"
            letterSpacing="1.5"
            className={`font-mono uppercase ${opstart ? 'motion-safe:animate-verschijn' : ''}`}
            style={opstart ? { animationDelay: `${0.75 + i * 0.07}s` } : undefined}
            fill={i === nu.getMonth() ? '#E9FDFF' : '#4F7682'}
          >
            {m}
          </text>
        )
      })}
      <path
        d={`M${ax} ${ay} A190 190 0 ${groteBoog} 1 ${bx} ${by}`}
        fill="none"
        stroke={`url(#${id}boog)`}
        strokeWidth="4"
        strokeLinecap="round"
        filter="url(#tf-reactor-gloed)"
        {...teken(opstart, 1.9)}
      />
      <circle cx={ax} cy={ay} r="5" fill={PETROL} filter="url(#tf-reactor-gloed)" {...verschijn(opstart, 1.8)} />
      <circle
        cx={bx}
        cy={by}
        r="6"
        fill="#070C0B"
        stroke={AMBER}
        strokeWidth="2"
        filter="url(#tf-reactor-gloed)"
        {...verschijn(opstart, 2.6)}
      />
    </g>
  )
}

export function Reactor({
  nu,
  toerental = 'rust',
  opstart = false,
}: {
  nu: Date
  toerental?: Toerental
  opstart?: boolean
}) {
  const id = useId()
  // De spoelen: tien blokken rond de kern.
  const spoelOmtrek = 2 * Math.PI * 122
  const spoel = spoelOmtrek / 10

  return (
    <svg viewBox="-200 -200 400 400" aria-hidden="true" className="absolute inset-0 h-full w-full overflow-visible">
      <defs>
        <filter id="tf-reactor-gloed" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id={`${id}kern`}>
          <stop offset="0" stopColor="#BFF7FF" stopOpacity="0.4" />
          <stop offset="0.5" stopColor={PETROL} stopOpacity="0.18" />
          <stop offset="1" stopColor={PETROL} stopOpacity="0" />
        </radialGradient>
      </defs>

      <Jaarring nu={nu} opstart={opstart} />

      {/* De scanlijn: een wig die rondveegt, met een heldere voorkant. */}
      <g {...verschijn(opstart, 2.2)}>
        <Draaiend duur={7} toerental={toerental}>
          <path d="M0 0 L150 0 A150 150 0 0 0 122.9 -86 Z" fill={IJS} fillOpacity="0.07" />
          <line x1="0" y1="0" x2="150" y2="0" stroke={IJS} strokeOpacity="0.45" />
        </Draaiend>
      </g>

      <Ontsteek aan={opstart} na={0.5}>
        <Draaiend duur={50} terug toerental={toerental}>
          <circle r="150" fill="none" stroke={IJS} strokeOpacity="0.6" strokeWidth="2" strokeDasharray="60 14 8 14" />
        </Draaiend>
      </Ontsteek>
      <Ontsteek aan={opstart} na={0.35}>
        <Draaiend duur={30} toerental={toerental}>
          <circle r="138" fill="none" stroke={IJS} strokeOpacity="0.5" strokeDasharray="1 4" />
        </Draaiend>
      </Ontsteek>
      <Ontsteek aan={opstart} na={0.2}>
        <Draaiend duur={90} toerental={toerental}>
          <circle
            r="122"
            fill="none"
            stroke={IJS}
            strokeOpacity="0.22"
            strokeWidth="16"
            strokeDasharray={`${spoel - 14} 14`}
          />
          <circle r="131" fill="none" stroke={IJS} strokeOpacity="0.35" strokeDasharray={`${spoel * 1.07 - 4} 4`} />
        </Draaiend>
      </Ontsteek>

      {/* De kern: bij de opstart eerst een vonk, dan een schokgolf. */}
      <Ontsteek aan={opstart} na={0.1}>
        <circle r="92" fill="none" stroke={IJS} strokeOpacity="0.55" strokeWidth="1.5" />
      </Ontsteek>
      <g
        className={opstart ? 'motion-safe:animate-vonk' : undefined}
        style={opstart ? { transformOrigin: MIDDEN } : undefined}
      >
        <circle
          r="84"
          fill={`url(#${id}kern)`}
          className="motion-safe:animate-pulseer"
          style={toerental === 'scan' ? { animationDuration: '0.6s' } : undefined}
        />
      </g>
      {opstart && (
        <circle
          r="92"
          fill="none"
          stroke={PETROL}
          strokeWidth="3"
          className="opacity-0 motion-safe:animate-schok"
          style={{ transformOrigin: MIDDEN, animationDelay: '0.55s' }}
        />
      )}
      {toerental === 'vergrendeld' && (
        <circle
          r="92"
          fill="none"
          stroke={PETROL}
          strokeWidth="3"
          className="motion-safe:animate-golf"
          style={{ transformOrigin: MIDDEN }}
        />
      )}
      <g transform="translate(-63 -64.5) scale(0.75)" filter="url(#tf-reactor-gloed)">
        <path d="M40 116 L84 36 L128 116" fill="none" stroke="#F2FEFF" strokeWidth="16" {...teken(opstart, 1.0)} />
        <rect
          x="40"
          y="128"
          width="54"
          height="8"
          fill={PETROL}
          className={opstart ? 'motion-safe:animate-balk' : undefined}
          style={opstart ? { transformOrigin: '40px 132px', animationDelay: '1.6s' } : undefined}
        />
        <rect
          x="100"
          y="128"
          width="28"
          height="8"
          fill={PAARS}
          className={opstart ? 'motion-safe:animate-balk' : undefined}
          style={opstart ? { transformOrigin: '100px 132px', animationDelay: '1.85s' } : undefined}
        />
      </g>
    </svg>
  )
}
