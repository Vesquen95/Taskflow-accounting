import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { MailStand, type MailStatus } from './MailStand'

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: vi.fn() },
}))

const basis: MailStatus = {
  omleiden_naar: null,
  meldingen_aan: true,
  weekoverzicht_aan: true,
  ingesteld: true,
  wachtend: 0,
  laatst_verzonden: null,
  laatste_fout: null,
  laatste_antwoord: null,
}

function stel(stand: Partial<MailStatus>) {
  ;(supabase.rpc as unknown as Mock).mockImplementation(async (naam: string) =>
    naam === 'mail_status' ? { data: { ...basis, ...stand }, error: null } : { data: null, error: null }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MailStand', () => {
  it('zegt het als er nog nooit iets vertrok', async () => {
    stel({})
    render(<MailStand />)
    expect(await screen.findByText(/nog geen enkele mail verzonden/)).toBeInTheDocument()
  })

  it('maakt de testfase zichtbaar', async () => {
    // Wie niet weet dat alles omgeleid wordt, denkt dat collega's hun mail krijgen.
    stel({ omleiden_naar: 'test@voorbeeld.be' })
    render(<MailStand />)
    expect(await screen.findByText('test@voorbeeld.be')).toBeInTheDocument()
  })

  it('toont de laatste fout', async () => {
    stel({ laatste_fout: 'Invalid login: 535 Username and Password not accepted' })
    render(<MailStand />)
    expect(await screen.findByText(/535 Username and Password not accepted/)).toBeInTheDocument()
  })

  it('zegt het als het Gmail-wachtwoord nog ontbreekt', async () => {
    // Anders staat er eindeloos "1 bericht wacht", zonder uitleg.
    stel({ wachtend: 1, laatste_antwoord: { status: 503, op: '2026-10-03T11:32:09Z', inhoud: '{"fout":"…"}' } })
    render(<MailStand />)
    expect(await screen.findByText('Nog niet ingesteld.')).toBeInTheDocument()
  })

  it('toont een ander foutantwoord van de functie letterlijk', async () => {
    stel({ laatste_antwoord: { status: 500, op: '2026-10-03T11:32:09Z', inhoud: 'Geen instellingen' } })
    render(<MailStand />)
    expect(await screen.findByText(/antwoordde 500: Geen instellingen/)).toBeInTheDocument()
  })

  it('vraagt een testmail aan', async () => {
    stel({})
    render(<MailStand />)
    await userEvent.click(await screen.findByRole('button', { name: 'Stuur een testmail' }))
    expect(supabase.rpc).toHaveBeenCalledWith('mail_test_aanvragen')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Gevraagd/))
  })
})
