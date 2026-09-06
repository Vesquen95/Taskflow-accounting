import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SessieBewaker } from './SessieBewaker'
import type { Sessiebewaking } from '../hooks/useSessieBewaking'
import { INACTIVITEIT_MINUTEN } from '../lib/sessieduur'

const signOut = vi.fn<() => Promise<void>>(async () => {})
let bewaking: Sessiebewaking

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, signOut }),
}))
vi.mock('../hooks/useSessieBewaking', () => ({
  useSessieBewaking: () => bewaking,
}))

const blijfAangemeld = vi.fn()

describe('SessieBewaker', () => {
  beforeEach(() => {
    signOut.mockClear()
    blijfAangemeld.mockClear()
    bewaking = { stand: 'actief', secondenResterend: 900, blijfAangemeld }
  })

  it('blijft onzichtbaar zolang er niets aan de hand is', () => {
    render(<SessieBewaker />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('telt af en biedt aan om aangemeld te blijven bij stilte', async () => {
    bewaking = { stand: 'waarschuwing', reden: 'inactiviteit', secondenResterend: 95, blijfAangemeld }
    render(<SessieBewaker />)

    const venster = screen.getByRole('alertdialog')
    expect(venster).toHaveTextContent('1:35')
    expect(venster).toHaveTextContent(String(INACTIVITEIT_MINUTEN))

    await userEvent.click(screen.getByRole('button', { name: 'Ik ben er nog' }))
    expect(blijfAangemeld).toHaveBeenCalledTimes(1)
  })

  it('biedt geen verlenging aan als de sessieduur op is', () => {
    // Tegen de absolute grens helpt "ik ben er nog" niet. Een knop die niets
    // doet is erger dan geen knop.
    bewaking = { stand: 'waarschuwing', reden: 'sessieduur', secondenResterend: 30, blijfAangemeld }
    render(<SessieBewaker />)

    expect(screen.queryByRole('button', { name: 'Ik ben er nog' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nu afmelden' })).toBeInTheDocument()
  })
})
