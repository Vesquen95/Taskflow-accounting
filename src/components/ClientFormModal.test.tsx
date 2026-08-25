import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientFormModal } from './ClientFormModal'
import type { Client, Employee } from '../types'

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    firm_id: 'f1',
    auth_user_id: 'auth-1',
    naam: 'Jan Janssens',
    email: 'jan@firm.be',
    rol: 'medewerker',
    mag_goedkeuren: false,
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    firm_id: 'f1',
    naam: 'Acme BV',
    ondernemingsnummer: 'BE0123.456.789',
    rechtsvorm: 'BV',
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'periodieke_aangever',
    btw_aangifte_frequentie: 'kwartaal',
    mandataris: true,
    vertrouwelijk: false,
    standaard_verantwoordelijke_id: 'e1',
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const employees = [employee({ id: 'e1', naam: 'Jan Janssens' }), employee({ id: 'e2', naam: 'Els Peeters' })]

const onClose = vi.fn()
const onSubmit = vi.fn()

beforeEach(() => {
  onClose.mockReset()
  onSubmit.mockReset()
  onSubmit.mockResolvedValue(undefined)
})

describe('ClientFormModal — required-field validation', () => {
  it('requires a non-empty naam', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), '   ')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Naam is verplicht.')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ClientFormModal — vertrouwelijk ⇒ verplichte standaard verantwoordelijke (§7 decision 4)', () => {
  it('blocks submit with a clear error when vertrouwelijk is checked but no responsible employee is chosen', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), 'Confidential Client BV')
    await user.click(screen.getByRole('checkbox', { name: 'Vertrouwelijk' }))
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Een vertrouwelijke klant vereist een standaard verantwoordelijke.'
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows an explanatory note once vertrouwelijk is checked', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    expect(screen.queryByText(/enkel zichtbaar voor de kantoorbeheerder/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Vertrouwelijk' }))
    expect(screen.getByText(/enkel zichtbaar voor de kantoorbeheerder/)).toBeInTheDocument()
  })

  it('submits successfully once a standaard verantwoordelijke is chosen for a confidential client', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), 'Confidential Client BV')
    await user.click(screen.getByRole('checkbox', { name: 'Vertrouwelijk' }))
    await user.selectOptions(screen.getByLabelText('Standaard verantwoordelijke *'), 'e2')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ naam: 'Confidential Client BV', vertrouwelijk: true, standaard_verantwoordelijke_id: 'e2' })
    )
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ClientFormModal — BTW-regime dependent field (checked-constraint mirror)', () => {
  it('shows the aangiftefrequentie select only for periodieke_aangever, defaulting to kwartaal', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    expect(screen.queryByText('Aangiftefrequentie')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('BTW-regime'), 'periodieke_aangever')
    const freqSelect = screen.getByLabelText('Aangiftefrequentie') as HTMLSelectElement
    expect(freqSelect.value).toBe('kwartaal')
  })

  it('clears the aangiftefrequentie when switching away from periodieke_aangever', async () => {
    const user = userEvent.setup()
    render(
      <ClientFormModal client={client({ btw_regime: 'periodieke_aangever', btw_aangifte_frequentie: 'maand' })} employees={employees} onClose={onClose} onSubmit={onSubmit} />
    )

    await user.selectOptions(screen.getByLabelText('BTW-regime'), 'geen')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ btw_regime: 'geen', btw_aangifte_frequentie: '' }))
  })
})

describe('ClientFormModal — editing an existing client', () => {
  it('prefills the form from the client prop', () => {
    render(
      <ClientFormModal client={client({ naam: 'Existing Co', mandataris: false })} employees={employees} onClose={onClose} onSubmit={onSubmit} />
    )
    const naamInput = screen.getByLabelText('Naam *') as HTMLInputElement
    expect(naamInput.value).toBe('Existing Co')
    expect(screen.getByRole('checkbox', { name: 'Mandataris' })).not.toBeChecked()
  })

  it('shows an Actief checkbox only when editing an existing client, not when creating one', () => {
    const { rerender } = render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.queryByRole('checkbox', { name: 'Actief' })).not.toBeInTheDocument()

    rerender(<ClientFormModal client={client()} employees={employees} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.getByRole('checkbox', { name: 'Actief' })).toBeInTheDocument()
  })
})

describe('ClientFormModal — submit error handling', () => {
  it('shows the returned error and does not close the modal when onSubmit rejects', async () => {
    const user = userEvent.setup()
    onSubmit.mockRejectedValue(new Error('Ondernemingsnummer al in gebruik.'))
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), 'Acme BV')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Ondernemingsnummer al in gebruik.')
    expect(onClose).not.toHaveBeenCalled()
  })

  // Regressie op de productiebug: bij het aanmaken van een klant weigerde RLS
  // de insert, maar de gebruiker zag enkel "Opslaan is mislukt." omdat het
  // PostgREST-foutobject geen `Error`-instantie is. Melding én SQLSTATE
  // moeten nu zichtbaar zijn.
  it('shows the RLS reason and SQLSTATE when the insert is refused by row-level security', async () => {
    const user = userEvent.setup()
    onSubmit.mockRejectedValue({
      message: 'new row violates row-level security policy for table "clients"',
      code: '42501',
      details: null,
      hint: null,
    })
    render(<ClientFormModal client={null} employees={employees} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), 'Acme BV')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Opslaan is mislukt: Je hebt geen rechten voor deze actie.')
    expect(alert).toHaveTextContent('row-level security')
    expect(alert).toHaveTextContent('code 42501')
    expect(onClose).not.toHaveBeenCalled()
  })
})
