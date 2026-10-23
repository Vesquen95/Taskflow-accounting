import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Begroeting } from './Begroeting'

const spreek = vi.fn()
vi.mock('../lib/begroeting', async (orig) => ({
  ...(await orig<typeof import('../lib/begroeting')>()),
  spreek: (t: string) => spreek(t),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T14:05:00'))
  spreek.mockReset()
  window.sessionStorage.setItem('taskflow.begroeting', '1')
})
afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('Begroeting', () => {
  it('begroet bij voornaam, wist de vlag en verdwijnt vanzelf', () => {
    const onKlaar = vi.fn()
    render(<Begroeting naam="Wibren Patteaux" onKlaar={onKlaar} />)
    expect(screen.getByRole('status')).toHaveTextContent('Toegang verleend')
    expect(screen.getByRole('status')).toHaveTextContent('Good afternoon, Wibren.')
    expect(window.sessionStorage.getItem('taskflow.begroeting')).toBeNull()
    expect(spreek).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(2600))
    expect(onKlaar).toHaveBeenCalled()
  })

  it('spreekt alleen als de stem aan staat', () => {
    window.localStorage.setItem('taskflow.weergave.stem', 'aan')
    render(<Begroeting naam="Wibren Patteaux" onKlaar={vi.fn()} />)
    expect(spreek).toHaveBeenCalledWith('Good afternoon, Wibren. Welcome back. All systems are online.')
  })

  it('zegt sir als dat gekozen is', () => {
    window.localStorage.setItem('taskflow.weergave.stem', 'aan')
    window.localStorage.setItem('taskflow.weergave.aanspreking', 'sir')
    render(<Begroeting naam="Wibren Patteaux" onKlaar={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Good afternoon, sir.')
    expect(screen.getByRole('status')).toHaveTextContent('Welkom terug, Wibren')
    expect(spreek).toHaveBeenCalledWith('Good afternoon, sir. Welcome back. All systems are online.')
  })

  it('gaat meteen weg bij een toets', () => {
    const onKlaar = vi.fn()
    render(<Begroeting naam="Wibren" onKlaar={onKlaar} />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(onKlaar).toHaveBeenCalled()
  })
})
