import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { supabase } from '../lib/supabase'
import { createSupabaseMock, type ChainState } from '../test/supabaseMock'
import { KalenderPage } from './KalenderPage'
import { eindeVanDeWeek } from '../lib/startvenster'
import type { Employee } from '../types'

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

/** Wie er kijkt. Per test overschreven vóór het renderen.
 *
 *  Bewust een NIEUW object per aanroep, want zo gedraagt de echte hook zich
 *  ook: die bouwt zijn resultaat elke render opnieuw op. Zou de kalender zijn
 *  standaardfilter opnieuw zetten telkens `employee` van identiteit verandert,
 *  dan stampt hij over de keuze van de gebruiker heen. Met een gedeeld object
 *  zou die fout onzichtbaar blijven. */
const kijker: { employee: Employee | null } = { employee: null }
vi.mock('../hooks/useCurrentEmployee', () => ({
  useCurrentEmployee: () => ({
    employee: kijker.employee ? { ...kijker.employee } : null,
    loading: false,
    error: null,
  }),
}))

function medewerker(over: Partial<Employee> = {}): Employee {
  return {
    id: 'jan',
    firm_id: 'f1',
    auth_user_id: 'auth-1',
    naam: 'Jan Janssens',
    email: 'jan@rsm.be',
    rol: 'medewerker',
    niveau: 'junior',
    mag_goedkeuren: false,
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function vandaagIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** De filters van de laatste taken-query, als {methode: argumenten}. */
let laatsteTakenQuery: ChainState | null = null

function toon(employee: Employee | null) {
  kijker.employee = employee
  laatsteTakenQuery = null
  ;(supabase.from as Mock).mockImplementation(
    createSupabaseMock({
      task_instances: (state) => {
        laatsteTakenQuery = state
        return { data: [], error: null, count: 0 }
      },
      employees: () => ({ data: [], error: null }),
      teams: () => ({ data: [], error: null }),
    }).from
  )
  render(<KalenderPage />)
}

function filterArgs(methode: string): unknown[][] {
  return (laatsteTakenQuery?.calls ?? [])
    .filter((c) => c.method === methode)
    .map((c) => c.args)
}

beforeEach(() => {
  vi.clearAllMocks()
  kijker.employee = null
})

describe('KalenderPage — waar je binnenkomt', () => {
  it('zet een junior op zijn eigen werk van deze week', async () => {
    toon(medewerker({ id: 'jan', niveau: 'junior' }))
    await waitFor(() => {
      // Op zijn naam...
      expect(filterArgs('eq')).toContainEqual(['toegewezen_medewerker_id', 'jan'])
      // ...en niet verder dan zeven dagen.
      expect(filterArgs('lte')).toContainEqual(['due_date', eindeVanDeWeek(vandaagIso())])
    })
  })

  it('doet hetzelfde voor een senior', async () => {
    toon(medewerker({ id: 'nele', niveau: 'senior' }))
    await waitFor(() => {
      expect(filterArgs('eq')).toContainEqual(['toegewezen_medewerker_id', 'nele'])
    })
  })

  it('laat een manager kantoorbreed en zonder weekgrens binnenkomen', async () => {
    // Wie aanstuurt kijkt naar de ploeg, niet naar zijn eigen lijstje.
    toon(medewerker({ id: 'karel', niveau: 'manager' }))
    await waitFor(() => expect(laatsteTakenQuery).not.toBeNull())
    expect(filterArgs('eq')).not.toContainEqual(['toegewezen_medewerker_id', 'karel'])
    expect(filterArgs('lte')).not.toContainEqual(['due_date', eindeVanDeWeek(vandaagIso())])
  })

  it('is een standaard en geen muur: de junior kan de week openzetten', async () => {
    const user = userEvent.setup()
    toon(medewerker({ id: 'jan', niveau: 'junior' }))
    await waitFor(() =>
      expect(filterArgs('lte')).toContainEqual(['due_date', eindeVanDeWeek(vandaagIso())])
    )

    await user.selectOptions(screen.getByLabelText('Periode'), 'alles')
    await waitFor(() => {
      expect(filterArgs('lte')).not.toContainEqual(['due_date', eindeVanDeWeek(vandaagIso())])
    })
  })

  it('springt niet terug nadat de junior zelf iets anders koos', async () => {
    // De standaard wordt één keer toegepast. Zou hij bij elke render opnieuw
    // gezet worden, dan kon de gebruiker zijn eigen keuze niet vasthouden.
    const user = userEvent.setup()
    toon(medewerker({ id: 'jan', niveau: 'junior' }))
    await waitFor(() => expect(laatsteTakenQuery).not.toBeNull())

    await user.selectOptions(screen.getByLabelText('Medewerker'), 'alle')
    await waitFor(() => {
      expect(filterArgs('eq')).not.toContainEqual(['toegewezen_medewerker_id', 'jan'])
    })
  })

  it('zegt bij een lege week dat het alleen over deze week gaat', async () => {
    // Anders denkt een junior dat hij helemaal klaar is.
    toon(medewerker({ id: 'jan', niveau: 'junior' }))
    expect(await screen.findByText('Niets meer deze week.')).toBeInTheDocument()
    expect(screen.getByText(/binnen zeven dagen vervalt/)).toBeInTheDocument()
  })
})
