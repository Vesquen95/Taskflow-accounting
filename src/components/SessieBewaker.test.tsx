import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SessieBewaker } from './SessieBewaker'
import type { Sessiebediening, Sessiestandaard } from '../hooks/useSessie'
import { INACTIVITEIT_MINUTEN } from '../lib/sessieduur'

const signOut = vi.fn<() => Promise<void>>(async () => {})
let stand: Sessiestandaard
let bediening: Sessiebediening

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, signOut }),
}))
vi.mock('../hooks/useSessie', () => ({
  useSessiestand: () => stand,
  useSessiebediening: () => bediening,
}))

const blijfAangemeld = vi.fn()
const zetLangeSessie = vi.fn()

/** 07/09/2026 om 21:04 — het uur dat op de knop hoort te staan. */
const EINDE = new Date('2026-09-07T21:04:00').getTime()

describe('SessieBewaker', () => {
  beforeEach(() => {
    signOut.mockClear()
    blijfAangemeld.mockClear()
    zetLangeSessie.mockClear()
    stand = { stand: 'actief', secondenResterend: 900 }
    bediening = { blijfAangemeld, langeSessie: false, zetLangeSessie, eindeSessie: EINDE }
  })

  it('blijft onzichtbaar zolang er niets aan de hand is', () => {
    render(<SessieBewaker />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('telt af en biedt aan om aangemeld te blijven bij stilte', async () => {
    stand = { stand: 'waarschuwing', reden: 'inactiviteit', secondenResterend: 95 }
    render(<SessieBewaker />)

    const venster = screen.getByRole('alertdialog')
    expect(venster).toHaveTextContent('1:35')
    expect(venster).toHaveTextContent(String(INACTIVITEIT_MINUTEN))

    await userEvent.click(screen.getByRole('button', { name: 'Ik ben er nog' }))
    expect(blijfAangemeld).toHaveBeenCalledTimes(1)
  })

  it('biedt hier ook aan om de sessie meteen open te houden', async () => {
    // Dit is net het moment waarop je merkt dat je de hele dag bezig bent.
    stand = { stand: 'waarschuwing', reden: 'inactiviteit', secondenResterend: 95 }
    render(<SessieBewaker />)

    await userEvent.click(screen.getByRole('button', { name: 'Open houden tot 21:04' }))
    expect(zetLangeSessie).toHaveBeenCalledWith(true)
  })

  it('biedt dat niet nog eens aan als het al aan staat', () => {
    stand = { stand: 'waarschuwing', reden: 'sessieduur', secondenResterend: 95 }
    bediening = { blijfAangemeld, langeSessie: true, zetLangeSessie, eindeSessie: EINDE }
    render(<SessieBewaker />)

    expect(screen.queryByRole('button', { name: /open houden/i })).not.toBeInTheDocument()
  })

  it('biedt geen verlenging aan als de sessieduur op is', () => {
    // Tegen de absolute grens helpt "ik ben er nog" niet. Een knop die niets
    // doet is erger dan geen knop.
    stand = { stand: 'waarschuwing', reden: 'sessieduur', secondenResterend: 30 }
    render(<SessieBewaker />)

    expect(screen.queryByRole('button', { name: 'Ik ben er nog' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open houden/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nu afmelden' })).toBeInTheDocument()
  })
})
