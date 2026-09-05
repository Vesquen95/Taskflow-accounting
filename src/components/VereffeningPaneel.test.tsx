import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { VereffeningPaneel } from './VereffeningPaneel'

function toon(ontbondenOp: string | null, vereffendOp: string | null) {
  const onOntbonden = vi.fn(async () => {})
  const onVereffend = vi.fn(async () => {})
  render(
    <VereffeningPaneel
      ontbondenOp={ontbondenOp}
      vereffendOp={vereffendOp}
      onOntbonden={onOntbonden}
      onVereffend={onVereffend}
    />
  )
  return { onOntbonden, onVereffend }
}

describe('VereffeningPaneel', () => {
  it('houdt zich stil bij een gewoon dossier', () => {
    toon(null, null)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByRole('button', { name: /in vereffening/i })).toBeInTheDocument()
  })

  it('zegt bij een lopende vereffening dat alles doorloopt', () => {
    // Het onderscheid waar het om draait: ontbonden is niet vereffend. Zolang
    // de vereffening loopt, dient de vereffenaar gewoon elk jaar in.
    toon('2026-04-30', null)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/In vereffening sinds/)
    expect(screen.getByText(/verplichtingen lopen gewoon door/i)).toBeInTheDocument()
  })

  it('maakt van een lange vereffening geen probleem', () => {
    // Zeven jaar oud en nog altijd gewoon "in vereffening": er is geen termijn
    // na dewelke het scherm iets anders zou moeten tonen.
    toon('2019-01-01', null)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/In vereffening sinds/)
  })

  it('sluit de vereffening pas op een ingevulde datum', async () => {
    const user = userEvent.setup()
    const { onVereffend } = toon('2026-04-30', null)
    const veld = screen.getByLabelText('Datum van de sluiting van de vereffening')
    expect(onVereffend).not.toHaveBeenCalled()
    await user.type(veld, '2029-09-30')
    expect(onVereffend).toHaveBeenCalledWith('2029-09-30')
  })

  it('toont bij een gesloten vereffening allebei de datums', () => {
    toon('2026-04-30', '2029-09-30')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Vereffend op/)
    expect(screen.getByText(/In vereffening sinds/)).toBeInTheDocument()
  })

  it('waarschuwt dat de aangifte over het vereffeningstijdperk handwerk is', () => {
    // De termijn daarvan loopt vanaf de goedkeuring van de resultaten van de
    // vereffening (art. 310, tweede lid WIB 92) — geen formule, dus de motor
    // maakt die taak niet. Dat stil laten zou een gemiste aangifte opleveren.
    toon('2026-04-30', '2029-09-30')
    expect(screen.getByText(/met de hand toe te voegen/i)).toBeInTheDocument()
    expect(screen.getByText(/vereffeningstijdperk/i)).toBeInTheDocument()
  })
})
