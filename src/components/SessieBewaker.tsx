import { useAuth } from '../hooks/useAuth'
import { useSessieBewaking } from '../hooks/useSessieBewaking'
import { INACTIVITEIT_MINUTEN, SESSIE_UREN, telAf } from '../lib/sessieduur'

/**
 * De waarschuwing vlak voor het automatisch afmelden.
 *
 * Staat als los onderdeel naast de rest van de app, en niet erin: dit ding
 * tikt elke seconde, en die tik hoort niet het hele scherm opnieuw te laten
 * tekenen.
 */
export function SessieBewaker() {
  const { user, signOut } = useAuth()
  const { stand, reden, secondenResterend, blijfAangemeld } = useSessieBewaking(
    user?.id ?? null,
    signOut
  )

  if (stand !== 'waarschuwing') return null

  const doorInactiviteit = reden === 'inactiviteit'

  return (
    <div
      role="alertdialog"
      aria-labelledby="sessie-waarschuwing-titel"
      aria-describedby="sessie-waarschuwing-uitleg"
      className="fixed bottom-4 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-amber-300 bg-white p-4 shadow-lg"
    >
      <h2 id="sessie-waarschuwing-titel" className="text-sm font-semibold text-slate-900">
        Je wordt over <span className="tabular-nums">{telAf(secondenResterend)}</span> afgemeld
      </h2>
      <p id="sessie-waarschuwing-uitleg" className="mt-1 text-sm text-slate-600">
        {doorInactiviteit
          ? `Er gebeurde ${INACTIVITEIT_MINUTEN} minuten niets. Een scherm dat open blijft staan toont de dossiers van het kantoor aan wie er langsloopt.`
          : `Een aanmelding gaat ${SESSIE_UREN} uur mee. Meld je straks opnieuw aan om verder te werken; je werk is bewaard.`}
      </p>
      <div className="mt-3 flex gap-2">
        {doorInactiviteit && (
          <button
            type="button"
            onClick={blijfAangemeld}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Ik ben er nog
          </button>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Nu afmelden
        </button>
      </div>
    </div>
  )
}
