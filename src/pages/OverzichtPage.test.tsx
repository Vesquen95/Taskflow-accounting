import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { OverzichtPage } from './OverzichtPage'
import type { OverzichtRij } from '../hooks/useKantooroverzicht'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

function rij(over: Partial<OverzichtRij> = {}): OverzichtRij {
  return {
    team_id: 't1',
    team_code: 'ZAV1',
    team_naam: 'Zaventem 1',
    open_totaal: 40,
    te_laat: 0,
    te_laat_wettelijk: 0,
    niemand_op: 0,
    niemand_op_te_laat: 0,
    te_lang_bij_klant: 0,
    wacht_op_goedkeuring: 0,
    ...over,
  }
}

function toon(rijen: OverzichtRij[]) {
  ;(supabase.rpc as Mock).mockResolvedValue({ data: rijen, error: null })
  const navigate = vi.fn()
  render(<OverzichtPage navigate={navigate} />)
  return { navigate }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OverzichtPage', () => {
  it('haalt de getallen bij de databank en telt ze niet zelf uit taken', async () => {
    // Het oude workload-scherm haalde élke openstaande taak op om er getallen
    // van te maken. Deze test legt vast dat dat niet terugkomt: één RPC, geen
    // tabelquery.
    toon([rij()])
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('kantooroverzicht'))
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('telt de teams samen in de vier getallen bovenaan', async () => {
    toon([
      rij({ team_id: 't1', team_code: 'ZAV1', te_laat: 3, niemand_op_te_laat: 1 }),
      rij({ team_id: 't2', team_code: 'AAL', team_naam: 'Aalst', te_laat: 4, niemand_op_te_laat: 2 }),
    ])
    // 1 + 2 = 3, in het blok dat bij dat label hoort. Via de rol en niet via
    // de tekst: het label staat óók boven de tabelkolom, en dan zou de test
    // niet weten welke van de twee ze nakijkt.
    const blok = await screen.findByRole('group', { name: 'Te laat, niemand op' })
    expect(blok).toHaveTextContent('3')
    expect(await screen.findByRole('group', { name: 'Te laat' })).toHaveTextContent('7')
  })

  it('zet "te laat en niemand op" vooraan', async () => {
    // Dat is het enige getal waar geen mens achter zit die eraan herinnerd
    // wordt. Alle andere achterstand staat bij iemand op de lijst.
    toon([rij({ te_laat: 5, niemand_op_te_laat: 2 })])
    const blokken = await screen.findAllByRole('group')
    expect(blokken[0]).toHaveAccessibleName('Te laat, niemand op')
  })

  it('splitst de achterstand uit naar wat wettelijk is', async () => {
    // Een gemiste wettelijke termijn kost het kantoor iets anders dan een
    // gemiste interne rapportering.
    toon([rij({ te_laat: 7, te_laat_wettelijk: 5 })])
    expect(await screen.findByText(/5 wettelijk/)).toBeInTheDocument()
  })

  it('noemt een dossier zonder team bij naam in plaats van leeg te blijven', async () => {
    toon([rij({ team_id: null, team_code: null, team_naam: null, te_laat: 1 })])
    expect(await screen.findByText('Zonder team')).toBeInTheDocument()
  })

  it('stuurt door naar goedkeuren wanneer daar iets ligt', async () => {
    const user = userEvent.setup()
    const { navigate } = toon([rij({ wacht_op_goedkeuring: 4 })])
    await user.click(await screen.findByRole('button', { name: /Naar goedkeuren \(4\)/ }))
    expect(navigate).toHaveBeenCalledWith('goedkeuring')
  })

  it('laat de knop naar goedkeuren weg als er niets ligt', async () => {
    toon([rij({ wacht_op_goedkeuring: 0 })])
    await screen.findByText('Overzicht')
    expect(screen.queryByRole('button', { name: /Naar goedkeuren/ })).toBeNull()
  })

  it('zegt het wanneer er niets te tonen is', async () => {
    toon([])
    expect(await screen.findByText(/Geen lopend werk/)).toBeInTheDocument()
  })
})
