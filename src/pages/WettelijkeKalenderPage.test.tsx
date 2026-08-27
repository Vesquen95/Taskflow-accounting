import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WettelijkeKalenderPage } from './WettelijkeKalenderPage'

/** Feestdagcorrectie in de UI (security-bevinding 2026-08-25:
 * retract_public_holiday() bestond al in de database, maar niets in de app
 * riep hem aan — een verkeerde feestdag verschuift álle open deadlines en
 * was alleen nog met databasetoegang te herstellen). */

const retractHoliday = vi.fn()
const addHoliday = vi.fn()
const addEntry = vi.fn()
const generateTaskInstances = vi.fn()
const laadFeestdagen = vi.fn()
let onderhoud: {
  id: string; gestart_op: string; geeindigd_op: string | null; aanleiding: string
  nieuwe_taken: number | null; nieuwe_feestdagen: number | null; fout: string | null
} | null = null

const holidays = [
  {
    id: 'ph-actief',
    jaar: 2027,
    datum: '2027-07-21',
    omschrijving: 'Nationale feestdag',
    aangemaakt_door: 'emp-1',
    gewijzigd_door: 'emp-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ingetrokken: false,
    ingetrokken_door: null,
    ingetrokken_op: null,
    ingetrokken_reden: null,
  },
  {
    id: 'ph-ingetrokken',
    jaar: 2027,
    datum: '2027-11-12',
    omschrijving: 'Foutieve wapenstilstand',
    aangemaakt_door: 'emp-1',
    gewijzigd_door: 'emp-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ingetrokken: true,
    ingetrokken_door: 'emp-1',
    ingetrokken_op: '2026-01-02T00:00:00Z',
    ingetrokken_reden: 'Verkeerde datum ingevoerd',
  },
]

let rol: 'kantoorbeheerder' | 'medewerker' = 'kantoorbeheerder'

vi.mock('../hooks/useLegalCalendar', () => ({
  useLegalCalendar: () => ({
    entries: [],
    holidays,
    onderhoud,
    loading: false,
    error: null,
    reload: vi.fn(),
    addEntry,
    addHoliday,
    retractHoliday,
    generateTaskInstances,
    laadFeestdagen,
  }),
}))

vi.mock('../hooks/useObligationTypes', () => ({
  useObligationTypes: () => ({ obligationTypes: [], loading: false, error: null }),
}))

vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({ employee: { id: 'emp-1', naam: 'Anke Beheerder', rol }, loading: false, error: null }),
}))

vi.mock('../hooks/useEmployees', () => ({
  useEmployees: () => ({
    employees: [{ id: 'emp-1', naam: 'Anke Beheerder', rol: 'kantoorbeheerder' }],
    loading: false,
    error: null,
  }),
}))

function holidayRow(name: string | RegExp) {
  return screen.getByText(name).closest('tr')!
}

beforeEach(() => {
  rol = 'kantoorbeheerder'
  retractHoliday.mockReset()
  retractHoliday.mockResolvedValue(undefined)
})

describe('WettelijkeKalenderPage — feestdagen', () => {
  it('shows a retracted holiday with who, when and why instead of hiding it', () => {
    render(<WettelijkeKalenderPage />)
    const row = holidayRow('Foutieve wapenstilstand')
    expect(within(row).getByText(/Ingetrokken door Anke Beheerder/)).toBeInTheDocument()
    expect(within(row).getByText(/Verkeerde datum ingevoerd/)).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Intrekken' })).not.toBeInTheDocument()
  })

  it('offers an Intrekken action on active holidays for a kantoorbeheerder', () => {
    render(<WettelijkeKalenderPage />)
    expect(within(holidayRow('Nationale feestdag')).getByRole('button', { name: 'Intrekken' })).toBeInTheDocument()
  })

  it('hides the Intrekken action from a plain medewerker', () => {
    rol = 'medewerker'
    render(<WettelijkeKalenderPage />)
    expect(within(holidayRow('Nationale feestdag')).queryByRole('button', { name: 'Intrekken' })).not.toBeInTheDocument()
  })

  it('requires a reason before calling the retract RPC', async () => {
    const user = userEvent.setup()
    render(<WettelijkeKalenderPage />)

    await user.click(within(holidayRow('Nationale feestdag')).getByRole('button', { name: 'Intrekken' }))
    await user.click(screen.getByRole('button', { name: 'Feestdag intrekken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/reden/i)
    expect(retractHoliday).not.toHaveBeenCalled()
  })

  it('retracts the holiday with the entered reason', async () => {
    const user = userEvent.setup()
    render(<WettelijkeKalenderPage />)

    await user.click(within(holidayRow('Nationale feestdag')).getByRole('button', { name: 'Intrekken' }))
    await user.type(screen.getByLabelText(/Reden/), 'Geen feestdag in 2027')
    await user.click(screen.getByRole('button', { name: 'Feestdag intrekken' }))

    await waitFor(() =>
      expect(retractHoliday).toHaveBeenCalledWith({ holidayId: 'ph-actief', reden: 'Geen feestdag in 2027' }),
    )
  })

  it('surfaces a database refusal instead of silently closing the dialog', async () => {
    retractHoliday.mockRejectedValue(new Error('Alleen een kantoorbeheerder kan een feestdag intrekken'))
    const user = userEvent.setup()
    render(<WettelijkeKalenderPage />)

    await user.click(within(holidayRow('Nationale feestdag')).getByRole('button', { name: 'Intrekken' }))
    await user.type(screen.getByLabelText(/Reden/), 'poging')
    await user.click(screen.getByRole('button', { name: 'Feestdag intrekken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/kantoorbeheerder/)
  })
})

describe('WettelijkeKalenderPage — dekking van de feestdagenkalender', () => {
  // De fixture heeft alleen losse feestdagen in 2027, dus de kalender loopt
  // sowieso achter op de horizon van 36 maanden. Precies de situatie waarin
  // de motor stilzwijgend alleen nog op weekends verschuift, en een algemene
  // vergadering op Nieuwjaar 2029 belandde.
  it('waarschuwt wanneer de kalender niet tot aan de horizon loopt', () => {
    rol = 'kantoorbeheerder'
    render(<WettelijkeKalenderPage />)

    expect(screen.getByText(/De feestdagenkalender loopt tot/)).toBeInTheDocument()
    expect(screen.getByText(/alleen nog op weekends/)).toBeInTheDocument()
  })

  it('laat de kantoorbeheerder de ontbrekende jaren aanvullen', async () => {
    rol = 'kantoorbeheerder'
    laadFeestdagen.mockResolvedValue(40)
    render(<WettelijkeKalenderPage />)

    await userEvent.click(screen.getByRole('button', { name: /Feestdagen .* aanvullen/ }))

    await waitFor(() => expect(laadFeestdagen).toHaveBeenCalled())
    const [van, tot] = laadFeestdagen.mock.calls[0]
    expect(tot).toBeGreaterThan(van)
    expect(await screen.findByText(/40 feestdagen toegevoegd/)).toBeInTheDocument()
  })

  it('biedt een medewerker de knop niet aan', () => {
    rol = 'medewerker'
    render(<WettelijkeKalenderPage />)

    expect(screen.getByText(/De feestdagenkalender loopt tot/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /aanvullen/ })).not.toBeInTheDocument()
  })
})

describe('WettelijkeKalenderPage — stand van het automatische onderhoud', () => {
  // Zonder dit blok schuift de maandelijkse job de horizon op zonder dat
  // iemand het ziet. Precies zo konden er ooit 182 taken ontbreken zonder dat
  // het opviel.
  const geslaagd = {
    id: 'log-1',
    gestart_op: '2026-09-01T03:00:00Z',
    geeindigd_op: '2026-09-01T03:00:12Z',
    aanleiding: 'cron',
    nieuwe_taken: 14,
    nieuwe_feestdagen: 10,
    fout: null,
  }

  it('toont wat de laatste ronde opleverde', () => {
    rol = 'kantoorbeheerder'
    onderhoud = geslaagd
    render(<WettelijkeKalenderPage />)

    expect(screen.getByText(/14 nieuwe taken/)).toBeInTheDocument()
    expect(screen.getByText(/10 nieuwe feestdagen/)).toBeInTheDocument()
  })

  it('zet een mislukte ronde in het rood, met de fout erbij', () => {
    rol = 'kantoorbeheerder'
    onderhoud = { ...geslaagd, nieuwe_taken: 0, fout: 'deadlock detected' }
    render(<WettelijkeKalenderPage />)

    // "mislukt" staat in een eigen <strong>; de zin eromheen is opgesplitst.
    expect(screen.getByText('mislukt')).toBeInTheDocument()
    expect(screen.getByText(/De laatste ronde van/)).toBeInTheDocument()
    expect(screen.getByText('deadlock detected')).toBeInTheDocument()
    // Een mislukte ronde mag nooit als "0 nieuwe taken" wegzakken: dat ziet
    // er hetzelfde uit als een ronde waarin niets te doen was.
    expect(screen.queryByText(/0 nieuwe taken/)).not.toBeInTheDocument()
  })

  it('waarschuwt wanneer er nog nooit onderhoud gedraaid heeft', () => {
    rol = 'kantoorbeheerder'
    onderhoud = null
    render(<WettelijkeKalenderPage />)

    expect(screen.getByText(/nog geen enkele onderhoudsronde/)).toBeInTheDocument()
  })
})
