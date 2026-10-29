import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock } from '../test/supabaseMock'
import { Begroeting } from './Begroeting'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const speelIntro = vi.fn()
const speelIntroBestand = vi.fn()
vi.mock('../lib/geluid', () => ({
  speelIntro: () => speelIntro(),
  speelIntroBestand: () => speelIntroBestand(),
}))

let achterstand = 0
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T14:05:00'))
  speelIntro.mockReset()
  // Standaard: geen eigen intronummer.
  speelIntroBestand.mockReset().mockResolvedValue(null)
  achterstand = 0
  window.sessionStorage.setItem('taskflow.begroeting', '1')
  const mock = createSupabaseMock({
    task_instances: (state) => ({
      data: null,
      error: null,
      count: state.calls.some((c) => c.method === 'lt') ? achterstand : 2,
    }),
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
})
afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

function toon(onKlaar = vi.fn()) {
  render(<Begroeting medewerkerId="e1" onKlaar={onKlaar} />)
  return onKlaar
}

/** Laat de telling binnenkomen. */
async function telling() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

describe('Begroeting', () => {
  it('zegt op het scherm wat de stem zegt, wist de vlag en verdwijnt vanzelf', async () => {
    const onKlaar = toon()
    expect(screen.getByRole('status')).toHaveTextContent('Toegang verleend')
    // Woord voor woord wat de stem in het intronummer zegt.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Good day, sir.I am ready to assist you.Systems are now fully operational.',
    )
    expect(window.sessionStorage.getItem('taskflow.begroeting')).toBeNull()
    await telling()
    expect(speelIntroBestand).not.toHaveBeenCalled()
    expect(speelIntro).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(5200))
    expect(onKlaar).toHaveBeenCalled()
  })

  it('toont een citaat en onthoudt welk, zodat het de volgende keer een ander is', async () => {
    toon()
    await telling()
    const eerste = window.localStorage.getItem('taskflow.begroeting.citaat')
    expect(['tijd', 'carpe']).toContain(eerste)
    expect(screen.getByRole('blockquote')).toBeInTheDocument()
  })

  it('roept Houston erbij als er taken te laat zijn', async () => {
    achterstand = 3
    // Met de achterstand telt Houston dubbel: met dit toeval valt het daarop.
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    toon()
    await telling()
    expect(screen.getByText('“Houston, we have a problem.”')).toBeInTheDocument()
    expect(screen.getByText('3 taken staan over hun deadline.')).toBeInTheDocument()
    vi.mocked(Math.random).mockRestore()
  })

  it('kiest zonder telling als die mislukt', async () => {
    ;(supabase.from as Mock).mockImplementation(() => {
      throw new Error('geen verbinding')
    })
    toon()
    await telling()
    expect(['tijd', 'carpe']).toContain(window.localStorage.getItem('taskflow.begroeting.citaat'))
  })

  it('valt terug op het muziekje als het intronummer niet laadt', async () => {
    window.localStorage.setItem('taskflow.weergave.stem', 'aan')
    toon()
    await telling()
    expect(speelIntroBestand).toHaveBeenCalled()
    expect(speelIntro).toHaveBeenCalled()
  })

  it('speelt het intronummer in plaats van het muziekje, zo lang als het duurt', async () => {
    window.localStorage.setItem('taskflow.weergave.stem', 'aan')
    const stop = vi.fn()
    speelIntroBestand.mockResolvedValue({ duur: 9.56, stop })
    const onKlaar = toon()
    await telling()
    expect(speelIntro).not.toHaveBeenCalled()
    // Het citaat staat er wel.
    expect(screen.getByRole('blockquote')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(5200))
    expect(onKlaar).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(4400))
    expect(onKlaar).toHaveBeenCalled()
  })

  it('stopt het nummer als je de begroeting overslaat', async () => {
    window.localStorage.setItem('taskflow.weergave.stem', 'aan')
    const stop = vi.fn()
    speelIntroBestand.mockResolvedValue({ duur: 9.56, stop })
    const { unmount } = render(<Begroeting medewerkerId="e1" onKlaar={vi.fn()} />)
    await telling()
    unmount()
    expect(stop).toHaveBeenCalled()
  })

  it('gaat meteen weg bij een toets', () => {
    const onKlaar = toon()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(onKlaar).toHaveBeenCalled()
  })
})
