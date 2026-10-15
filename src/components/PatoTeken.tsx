/**
 * Het teken van PATO Accountancy: de Λ met de petrol en de paarse balk.
 *
 * Dezelfde tekening als public/logo.svg (het favicon), maar zonder de donkere
 * tegel: in de cockpit staat het teken direct op de donkere balk. Inline, zodat
 * de balk kan bewegen wanneer de app laadt (`bezig`) -- alleen voor wie
 * beweging toelaat.
 */
export function PatoTeken({
  grootte = 28,
  bezig = false,
  className = '',
}: {
  grootte?: number
  bezig?: boolean
  className?: string
}) {
  return (
    <svg width={grootte} height={grootte} viewBox="24 18 120 128" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M40 116 L84 36 L128 116" fill="none" stroke="#3EF0D2" strokeWidth="16" />
      <rect
        x="40"
        y="128"
        width="54"
        height="8"
        fill="#3EF0D2"
        className={bezig ? 'origin-[40px_132px] motion-safe:animate-laadbalk' : ''}
      />
      <rect x="100" y="128" width="28" height="8" fill="#B57BFF" />
    </svg>
  )
}
