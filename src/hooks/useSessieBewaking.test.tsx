import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useSessieBewaking } from './useSessieBewaking'
import { INACTIVITEIT_MINUTEN, SESSIE_UREN } from '../lib/sessieduur'

const MIN = 60_000
const UUR = 60 * MIN

function Proef({ uid, signOut }: { uid: string | null; signOut: () => Promise<void> }) {
  const { stand, secondenResterend } = useSessieBewaking(uid, signOut)
  return (
    <div>
      <span data-testid="stand">{stand}</span>
      <span data-testid="resterend">{secondenResterend}</span>
    </div>
  )
}

/** Laat de klok en de tikkers samen vooruit lopen. */
async function verstrijk(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useSessieBewaking', () => {
  let signOut: Mock<() => Promise<void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T09:00:00Z'))
    window.localStorage.clear()
    signOut = vi.fn<() => Promise<void>>(async () => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('meldt af zodra er te lang niets gebeurde', async () => {
    render(<Proef uid="u-1" signOut={signOut} />)
    expect(screen.getByTestId('stand')).toHaveTextContent('actief')

    await verstrijk((INACTIVITEIT_MINUTEN - 1) * MIN)
    expect(signOut).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand')).toHaveTextContent('waarschuwing')

    await verstrijk(2 * MIN)
    expect(screen.getByTestId('stand')).toHaveTextContent('verlopen')
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('taskflow.sessie.reden')).toBe('inactiviteit')
  })

  it('meldt maar één keer af, ook als de tikker blijft lopen', async () => {
    render(<Proef uid="u-1" signOut={signOut} />)
    await verstrijk((INACTIVITEIT_MINUTEN + 5) * MIN)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('een klik zet de teller terug', async () => {
    render(<Proef uid="u-1" signOut={signOut} />)

    // Net vóór de waarschuwing nog eens iets doen.
    await verstrijk((INACTIVITEIT_MINUTEN - 5) * MIN)
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
    })
    await verstrijk((INACTIVITEIT_MINUTEN - 5) * MIN)

    expect(signOut).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand')).toHaveTextContent('actief')
  })

  it('tijdens de waarschuwing telt alleen de knop, geen losse klik', async () => {
    render(<Proef uid="u-1" signOut={signOut} />)
    await verstrijk((INACTIVITEIT_MINUTEN - 1) * MIN)
    expect(screen.getByTestId('stand')).toHaveTextContent('waarschuwing')

    // Wie de waarschuwing wegklikt of er per ongeluk langs strijkt, mag de
    // afmelding niet stilzwijgend uitstellen: er is een knop voor.
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
    })
    await verstrijk(2 * MIN)

    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('activiteit in een ander tabblad telt mee', async () => {
    render(<Proef uid="u-1" signOut={signOut} />)

    await verstrijk((INACTIVITEIT_MINUTEN - 5) * MIN)
    // Het andere tabblad schrijft zijn eigen stempel; wij lezen die bij de tik.
    window.localStorage.setItem('taskflow.sessie.activiteit', String(Date.now()))
    await verstrijk((INACTIVITEIT_MINUTEN - 5) * MIN)

    expect(signOut).not.toHaveBeenCalled()
  })

  it('een sessie die al te oud is bij het opstarten gaat meteen dicht', async () => {
    // Zoals een browser die gisteravond open bleef staan: Supabase heeft de
    // sessie bewaard, de stempels zijn van uren geleden.
    const lang = Date.now() - 3 * UUR
    window.localStorage.setItem('taskflow.sessie.start', `u-1|${lang}`)
    window.localStorage.setItem('taskflow.sessie.activiteit', String(lang))

    render(<Proef uid="u-1" signOut={signOut} />)
    await verstrijk(0)

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('taskflow.sessie.reden')).toBe('inactiviteit')
  })

  it('de stempel van een collega bindt de volgende gebruiker niet', async () => {
    // Ruim voorbij de absolute grens: zou de stempel van de collega tellen,
    // dan vloog wie hier aanmeldt er meteen weer uit.
    const lang = Date.now() - (SESSIE_UREN + 1) * UUR
    window.localStorage.setItem('taskflow.sessie.start', `iemand-anders|${lang}`)

    render(<Proef uid="u-1" signOut={signOut} />)
    await verstrijk(0)

    expect(signOut).not.toHaveBeenCalled()
  })

  it('wie de hele dag doorwerkt loopt tegen de absolute grens', async () => {
    render(<Proef uid="u-1" signOut={signOut} />)

    // Elk half uur iets doen, zodat de inactiviteit nooit toeslaat.
    // 25 minuten per ronde, ruim genoeg rondes om voorbij de absolute grens
    // te komen zonder ooit 30 minuten stil te vallen.
    for (let i = 0; i < SESSIE_UREN * 3; i++) {
      act(() => {
        window.dispatchEvent(new Event('keydown'))
      })
      await verstrijk(25 * MIN)
      if (signOut.mock.calls.length > 0) break
    }

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('taskflow.sessie.reden')).toBe('sessieduur')
  })

  it('doet niets zolang er niemand aangemeld is', async () => {
    render(<Proef uid={null} signOut={signOut} />)
    await verstrijk(24 * UUR)
    expect(signOut).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand')).toHaveTextContent('actief')
  })
})
