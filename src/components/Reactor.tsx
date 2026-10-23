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

/** De buitenste ring: het jaar, met de boog naar de volgende btw-termijn. */
function Jaarring({ nu }: { nu: Date }) {
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
      <circle r="190" fill="none" stroke={LIJN} />
      {Array.from({ length: 53 }, (_, w) => {
        const a = hoek(w * 7, dagenInJaar)
        const [x1, y1] = punt(a, 180)
        const [x2, y2] = punt(a, w % 4 === 0 ? 188 : 184)
        return <line key={w} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2B4B55" />
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
            className="font-mono uppercase"
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
      />
      <circle cx={ax} cy={ay} r="5" fill={PETROL} filter="url(#tf-reactor-gloed)" />
      <circle cx={bx} cy={by} r="6" fill="#070C0B" stroke={AMBER} strokeWidth="2" filter="url(#tf-reactor-gloed)" />
    </g>
  )
}

export function Reactor({ nu, toerental = 'rust' }: { nu: Date; toerental?: Toerental }) {
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

      <Jaarring nu={nu} />

      {/* De scanlijn: een wig die rondveegt, met een heldere voorkant. */}
      <Draaiend duur={7} toerental={toerental}>
        <path d="M0 0 L150 0 A150 150 0 0 0 122.9 -86 Z" fill={IJS} fillOpacity="0.07" />
        <line x1="0" y1="0" x2="150" y2="0" stroke={IJS} strokeOpacity="0.45" />
      </Draaiend>

      <Draaiend duur={50} terug toerental={toerental}>
        <circle r="150" fill="none" stroke={IJS} strokeOpacity="0.6" strokeWidth="2" strokeDasharray="60 14 8 14" />
      </Draaiend>
      <Draaiend duur={30} toerental={toerental}>
        <circle r="138" fill="none" stroke={IJS} strokeOpacity="0.5" strokeDasharray="1 4" />
      </Draaiend>
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

      {/* De kern. */}
      <circle r="92" fill="none" stroke={IJS} strokeOpacity="0.55" strokeWidth="1.5" />
      <circle
        r="84"
        fill={`url(#${id}kern)`}
        className="motion-safe:animate-pulseer"
        style={toerental === 'scan' ? { animationDuration: '0.6s' } : undefined}
      />
      {toerental === 'vergrendeld' && (
        <circle r="92" fill="none" stroke={PETROL} strokeWidth="3" className="motion-safe:animate-golf" style={{ transformOrigin: MIDDEN }} />
      )}
      <g transform="translate(-63 -64.5) scale(0.75)" filter="url(#tf-reactor-gloed)">
        <path d="M40 116 L84 36 L128 116" fill="none" stroke="#F2FEFF" strokeWidth="16" />
        <rect x="40" y="128" width="54" height="8" fill={PETROL} />
        <rect x="100" y="128" width="28" height="8" fill={PAARS} />
      </g>
    </svg>
  )
}
