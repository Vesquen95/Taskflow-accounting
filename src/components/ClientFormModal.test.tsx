import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ClientFormModal, type ClientFormValues } from './ClientFormModal'
import { supabase } from '../lib/supabase'
import { createSupabaseMock } from '../test/supabaseMock'
import type { Client, Employee, ObligationType, Team } from '../types'

// Het formulier haalt sinds de teams zelf de teamlijst op. Zonder mock zou de
// keuzelijst leeg blijven en zouden de tests hieronder niets kunnen kiezen.
vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} },
}))

const teams: Team[] = [
  { id: 't-aal', firm_id: 'f1', code: 'AAL', naam: 'Aalst', vestiging: 'Aalst', actief: true, created_at: '2026-01-01T00:00:00Z' },
  { id: 't-zav1', firm_id: 'f1', code: 'ZAV1', naam: 'Zaventem 1', vestiging: 'Zaventem', actief: true, created_at: '2026-01-01T00:00:00Z' },
]

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    firm_id: 'f1',
    auth_user_id: 'auth-1',
    naam: 'Jan Janssens',
    email: 'jan@firm.be',
    rol: 'medewerker',
    niveau: null,
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
    klantsoort: 'rechtspersoon',
    ondernemingsnummer: 'BE0123.456.789',
    rechtsvorm: 'BV',
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'periodieke_aangever',
    btw_aangifte_frequentie: 'kwartaal',
    mandataris: true,
    vertrouwelijk: false,
    standaard_verantwoordelijke_id: 'e1',
    team_id: null,
    actief: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const employees = [employee({ id: 'e1', naam: 'Jan Janssens' }), employee({ id: 'e2', naam: 'Els Peeters' })]

const obligationTypes: ObligationType[] = [
  { id: 'ot-av', code: 'algemene_vergadering', naam: 'Algemene vergadering', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'jaarlijks', werkstroom: 'afsluiting' },
  { id: 'ot-jaar', code: 'jaarafsluiting', naam: 'Jaarafsluiting', categorie: 'wettelijk', deadline_mechanisme: 'boekjaar_relatief', standaard_periodiciteit: 'jaarlijks', werkstroom: 'afsluiting' },
  { id: 'ot-btw', code: 'btw_aangifte', naam: 'BTW-aangifte', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: 'maand_of_kwartaal', werkstroom: 'btw' },
]

const onClose = vi.fn()
const onSubmit = vi.fn()

beforeEach(() => {
  onClose.mockReset()
  onSubmit.mockReset()
  onSubmit.mockResolvedValue(undefined)
  const mock = createSupabaseMock({
    teams: () => ({ data: teams, error: null }),
    employee_teams: () => ({ data: [{ employee_id: 'e2', team_id: 't-aal' }], error: null }),
  })
  ;(supabase.from as Mock).mockImplementation(mock.from)
})

describe('ClientFormModal — required-field validation', () => {
  it('requires a non-empty naam', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), '   ')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Naam is verplicht.')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ClientFormModal — vertrouwelijk ⇒ verplichte standaard verantwoordelijke (§7 decision 4)', () => {
  it('blocks submit with a clear error when vertrouwelijk is checked but no responsible employee is chosen', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

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
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    expect(screen.queryByText(/enkel zichtbaar voor de kantoorbeheerder/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Vertrouwelijk' }))
    expect(screen.getByText(/enkel zichtbaar voor de kantoorbeheerder/)).toBeInTheDocument()
  })

  it('submits successfully once a standaard verantwoordelijke is chosen for a confidential client', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

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
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    expect(screen.queryByText('Aangiftefrequentie')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('BTW-regime'), 'periodieke_aangever')
    const freqSelect = screen.getByLabelText('Aangiftefrequentie') as HTMLSelectElement
    expect(freqSelect.value).toBe('kwartaal')
  })

  it('clears the aangiftefrequentie when switching away from periodieke_aangever', async () => {
    const user = userEvent.setup()
    render(
      <ClientFormModal client={client({ btw_regime: 'periodieke_aangever', btw_aangifte_frequentie: 'maand' })} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />
    )

    await user.selectOptions(screen.getByLabelText('BTW-regime'), 'geen')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ btw_regime: 'geen', btw_aangifte_frequentie: '' }))
  })
})

describe('ClientFormModal — editing an existing client', () => {
  it('prefills the form from the client prop', () => {
    render(
      <ClientFormModal client={client({ naam: 'Existing Co', mandataris: false })} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />
    )
    const naamInput = screen.getByLabelText('Naam *') as HTMLInputElement
    expect(naamInput.value).toBe('Existing Co')
    expect(screen.getByRole('checkbox', { name: 'Fiscaal mandaat' })).not.toBeChecked()
  })

  // Het vinkje "Actief" uitzetten archiveert de klant en annuleert al zijn
  // openstaande taken (migratie 0026). Dat mag niet stil gebeuren, ook niet
  // langs deze weg -- de nadrukkelijke archiveeractie staat op het dossier.
  it('warns, with the number of tasks at stake, when Actief is unticked for an active client', async () => {
    const user = userEvent.setup()
    render(
      <ClientFormModal
        client={client()}
        employees={employees}
        obligationTypes={obligationTypes}
        openstaandeTaken={7}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
    expect(screen.queryByText(/archiveert deze klant/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Actief' }))

    expect(screen.getByText(/archiveert deze klant/)).toHaveTextContent('7 openstaande taken')
  })

  it('shows an Actief checkbox only when editing an existing client, not when creating one', () => {
    const { rerender } = render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.queryByRole('checkbox', { name: 'Actief' })).not.toBeInTheDocument()

    rerender(<ClientFormModal client={client()} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.getByRole('checkbox', { name: 'Actief' })).toBeInTheDocument()
  })
})

describe('ClientFormModal — submit error handling', () => {
  it('shows the returned error and does not close the modal when onSubmit rejects', async () => {
    const user = userEvent.setup()
    onSubmit.mockRejectedValue(new Error('Ondernemingsnummer al in gebruik.'))
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

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
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), 'Acme BV')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Opslaan is mislukt: Je hebt geen rechten voor deze actie.')
    expect(alert).toHaveTextContent('row-level security')
    expect(alert).toHaveTextContent('code 42501')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ClientFormModal — de catalogus komt later binnen', () => {
  // Gevonden door de e2e-test tegen de live site op 27/08/2026: wie meteen na
  // het openen van de klantenlijst op "Nieuwe klant" klikt, kreeg een leeg
  // vak Verplichtingen. De beginwaarde van useState wordt maar één keer
  // berekend, dus een catalogus die een fractie later binnenkomt haalde het
  // scherm nooit meer in. Gevolg: je kon niets aanvinken, en de nieuwe klant
  // kreeg alleen de btw-taken die de database zelf afleidt -- geen algemene
  // vergadering, geen jaarafsluiting.
  it('vult de verplichtingen alsnog aan zodra de types er zijn', async () => {
    const { rerender } = render(
      <ClientFormModal client={null} employees={employees} obligationTypes={[]} onClose={onClose} onSubmit={onSubmit} />
    )
    expect(screen.queryByRole('checkbox', { name: /Algemene vergadering/ })).not.toBeInTheDocument()

    rerender(
      <ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />
    )

    expect(await screen.findByRole('checkbox', { name: /Algemene vergadering/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Jaarafsluiting/ })).toBeInTheDocument()
  })

  it('houdt vast wat de gebruiker al aanvinkte terwijl de types binnenkomen', async () => {
    const eersteType = [obligationTypes[0]]
    const { rerender } = render(
      <ClientFormModal client={null} employees={employees} obligationTypes={eersteType} onClose={onClose} onSubmit={onSubmit} />
    )
    const vinkje = await screen.findByRole('checkbox', { name: new RegExp(eersteType[0].naam) })
    await userEvent.click(vinkje)
    expect(vinkje).toBeChecked()

    rerender(
      <ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />
    )

    expect(screen.getByRole('checkbox', { name: new RegExp(eersteType[0].naam) })).toBeChecked()
    // En de types die pas later binnenkwamen staan er nu ook bij.
    for (const type of obligationTypes.slice(1)) {
      expect(screen.getByRole('checkbox', { name: new RegExp(type.naam) })).toBeInTheDocument()
    }
  })
})

// ============================================================
// Gemeld door het kantoor op 28/08/2026: een klant met boekjaareinde 30/06,
// vorm "N-de weekdag", de drie keuzelijsten toonden "eerste", "maandag" en
// "augustus" -- en toch weigerde de database het opslaan met "De statutaire
// AV-datum is onvolledig of ongeldig" (23514). De keuzelijsten toonden hun
// waarde met een `??`-fallback: die stond alleen op het scherm en werd nooit
// in `parameters` geschreven zolang de gebruiker de lijst niet aanraakte.
//
// De regel voor dit systeem: wat het scherm toont is wat er opgeslagen wordt.
// Voor de statutaire AV-datum is dat "leeg tenzij bewust gekozen" -- een
// plausibele standaard die niemand koos zou een verkeerde deadline opleveren
// die er correct uitziet.
// ============================================================
function avParameters(values: ClientFormValues): Record<string, unknown> {
  const sel = values.obligations.find((o) => o.obligation_type_id === 'ot-av')
  if (!sel) throw new Error('geen AV-selectie in de ingediende waarden')
  return sel.parameters
}

function ingediendeWaarden(): ClientFormValues {
  expect(onSubmit).toHaveBeenCalledTimes(1)
  return onSubmit.mock.calls[0][0] as ClientFormValues
}

async function vulKlantEnKiesAv(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Naam *'), 'Zomer BV')
  await user.click(screen.getByRole('checkbox', { name: /Algemene vergadering/ }))
}

describe('ClientFormModal — de statutaire AV-datum: tonen == opslaan', () => {
  it('slaat op wat de keuzelijsten van de n-de weekdag tonen (geen weergave-only fallback)', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await vulKlantEnKiesAv(user)
    await user.click(screen.getByRole('radio', { name: 'N-de weekdag' }))
    // De gebruiker wijzigt alleen de maand en laat rang en weekdag staan zoals
    // het scherm ze toont -- precies wat het kantoor deed.
    await user.selectOptions(screen.getByLabelText('Maand'), '8')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    const parameters = avParameters(ingediendeWaarden())
    const rang = screen.getByLabelText('Rang') as HTMLSelectElement
    const weekdag = screen.getByLabelText('Weekdag') as HTMLSelectElement
    const maand = screen.getByLabelText('Maand') as HTMLSelectElement

    expect(parameters.av_rang ?? '').toBe(rang.value)
    expect(parameters.av_weekdag ?? '').toBe(weekdag.value)
    expect(String(parameters.av_maand ?? '')).toBe(maand.value)
  })

  it('kiest geen vorm voor de gebruiker: aanvinken alleen bewaart geen statutaire datum', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await vulKlantEnKiesAv(user)

    expect(screen.getByRole('radio', { name: 'Vaste datum' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'N-de weekdag' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Niet in de statuten' })).toBeChecked()
    // Geen dag/maand-velden zolang er geen vorm gekozen is.
    expect(screen.queryByLabelText('Maand')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Opslaan' }))
    expect(avParameters(ingediendeWaarden())).toEqual({})
  })

  it('toont lege keuzelijsten bij een vaste datum tot de gebruiker kiest, en bewaart dan exact dat', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await vulKlantEnKiesAv(user)
    await user.click(screen.getByRole('radio', { name: 'Vaste datum' }))

    expect((screen.getByLabelText('Dag van de maand') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Maand') as HTMLSelectElement).value).toBe('')

    await user.type(screen.getByLabelText('Dag van de maand'), '1')
    await user.selectOptions(screen.getByLabelText('Maand'), '4')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(avParameters(ingediendeWaarden())).toEqual({ av_vorm: 'vaste_datum', av_dag: 1, av_maand: 4 })
  })

  it('bewaart een volledig ingevulde n-de weekdag', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await vulKlantEnKiesAv(user)
    await user.click(screen.getByRole('radio', { name: 'N-de weekdag' }))
    await user.selectOptions(screen.getByLabelText('Rang'), 'eerste')
    await user.selectOptions(screen.getByLabelText('Weekdag'), 'maandag')
    await user.selectOptions(screen.getByLabelText('Maand'), '8')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(avParameters(ingediendeWaarden())).toEqual({
      av_vorm: 'nde_weekdag',
      av_rang: 'eerste',
      av_weekdag: 'maandag',
      av_maand: 8,
    })
  })

  it('laat bij het bewerken van een bestaande klant de ingevulde statuten ongemoeid', async () => {
    const user = userEvent.setup()
    render(
      <ClientFormModal
        client={client()}
        employees={employees}
        obligationTypes={obligationTypes}
        bestaandeVerplichtingen={[
          {
            obligation_type_id: 'ot-av',
            gekozen: true,
            standaard_toegewezen_medewerker_id: '',
            parameters: { av_vorm: 'nde_weekdag', av_rang: 'laatste', av_weekdag: 'vrijdag', av_maand: 4 },
          },
        ]}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )

    expect((screen.getByLabelText('Rang') as HTMLSelectElement).value).toBe('laatste')
    expect((screen.getByLabelText('Weekdag') as HTMLSelectElement).value).toBe('vrijdag')
    expect((screen.getByLabelText('Maand') as HTMLSelectElement).value).toBe('4')

    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(avParameters(ingediendeWaarden())).toEqual({
      av_vorm: 'nde_weekdag',
      av_rang: 'laatste',
      av_weekdag: 'vrijdag',
      av_maand: 4,
    })
  })

  it('laat geen parameters achter van een vorm die niet meer op het scherm staat', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await vulKlantEnKiesAv(user)
    await user.click(screen.getByRole('radio', { name: 'Vaste datum' }))
    await user.type(screen.getByLabelText('Dag van de maand'), '15')
    await user.selectOptions(screen.getByLabelText('Maand'), '6')

    await user.click(screen.getByRole('radio', { name: 'N-de weekdag' }))
    // De maand hoort bij beide vormen en blijft staan; de dag niet.
    expect((screen.getByLabelText('Maand') as HTMLSelectElement).value).toBe('6')
    await user.selectOptions(screen.getByLabelText('Rang'), 'tweede')
    await user.selectOptions(screen.getByLabelText('Weekdag'), 'donderdag')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(avParameters(ingediendeWaarden())).toEqual({
      av_vorm: 'nde_weekdag',
      av_rang: 'tweede',
      av_weekdag: 'donderdag',
      av_maand: 6,
    })
  })

  it('wist de statutaire datum wanneer de gebruiker teruggaat naar "Niet in de statuten"', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await vulKlantEnKiesAv(user)
    await user.click(screen.getByRole('radio', { name: 'Vaste datum' }))
    await user.type(screen.getByLabelText('Dag van de maand'), '1')
    await user.selectOptions(screen.getByLabelText('Maand'), '6')
    await user.click(screen.getByRole('radio', { name: 'Niet in de statuten' }))
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(avParameters(ingediendeWaarden())).toEqual({})
  })
})

describe('ClientFormModal — jaarafsluiting: de getoonde SLA staat ook echt in parameters', () => {
  it('schrijft sla_maanden weg bij het aanvinken, zonder dat het veld aangeraakt wordt', async () => {
    const user = userEvent.setup()
    render(<ClientFormModal client={null} employees={employees} obligationTypes={obligationTypes} onClose={onClose} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Naam *'), 'Zomer BV')
    await user.click(screen.getByRole('checkbox', { name: /Jaarafsluiting/ }))
    const veld = screen.getByLabelText('Klaar binnen (maanden na boekjaareinde)') as HTMLInputElement
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    const sel = ingediendeWaarden().obligations.find((o) => o.obligation_type_id === 'ot-jaar')
    expect(String(sel?.parameters.sla_maanden ?? '')).toBe(veld.value)
    expect(sel?.parameters).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
  })

  it('vult een bestaande jaarafsluiting zonder parameters aan met wat het scherm toont', async () => {
    const user = userEvent.setup()
    render(
      <ClientFormModal
        client={client()}
        employees={employees}
        obligationTypes={obligationTypes}
        bestaandeVerplichtingen={[
          { obligation_type_id: 'ot-jaar', gekozen: true, standaard_toegewezen_medewerker_id: '', parameters: {} },
        ]}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )

    const veld = screen.getByLabelText('Klaar binnen (maanden na boekjaareinde)') as HTMLInputElement
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    const sel = ingediendeWaarden().obligations.find((o) => o.obligation_type_id === 'ot-jaar')
    expect(String(sel?.parameters.sla_maanden ?? '')).toBe(veld.value)
  })
})

describe('ClientFormModal — patrimoniumtaks en de bijzondere btw-aangifte', () => {
  const types: ObligationType[] = [
    ...obligationTypes,
    { id: 'ot-patri', code: 'patrimoniumtaks', naam: 'Patrimoniumtaks (toetsen)', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: 'jaarlijks', werkstroom: 'vennootschapsbelasting' },
    { id: 'ot-bijz', code: 'btw_bijzondere_aangifte', naam: 'Bijzondere btw-aangifte (toetsen)', categorie: 'wettelijk', deadline_mechanisme: 'formule', standaard_periodiciteit: 'kwartaal', werkstroom: 'btw' },
  ]

  function toon(c: Client | null, bestaand: { obligation_type_id: string; gekozen: boolean }[] = []) {
    render(
      <ClientFormModal
        client={c}
        employees={employees}
        obligationTypes={types}
        bestaandeVerplichtingen={bestaand.map((b) => ({ ...b, parameters: {}, standaard_toegewezen_medewerker_id: 'e1' }))}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
  }

  it('biedt de patrimoniumtaks niet aan bij een herkende vennootschapsvorm', () => {
    toon(client({ rechtsvorm: 'BV' }))
    expect(screen.queryByText(/Patrimoniumtaks/i)).not.toBeInTheDocument()
  })

  it('biedt ze wel aan bij een vzw', () => {
    toon(client({ rechtsvorm: 'VZW' }))
    expect(screen.getByText(/Patrimoniumtaks/i)).toBeInTheDocument()
  })

  it('biedt ze ook aan bij een rechtsvorm die het scherm niet kent', () => {
    // Niet weten is geen reden om een wettelijke taks te verbergen.
    toon(client({ rechtsvorm: 'Buitenlandse entiteit' }))
    expect(screen.getByText(/Patrimoniumtaks/i)).toBeInTheDocument()
  })

  it('blijft een reeds aangevinkte patrimoniumtaks tonen, ook bij een vennootschap', () => {
    // Anders verdwijnt ze van het scherm terwijl ze opgeslagen blijft: het
    // scherm zou dan iets anders tonen dan wat er in de databank staat.
    toon(client({ rechtsvorm: 'BV' }), [{ obligation_type_id: 'ot-patri', gekozen: true }])
    expect(screen.getByText(/Patrimoniumtaks/i)).toBeInTheDocument()
  })

  it('zet de bijzondere btw-aangifte bij het btw-regime en niet in de lijst', async () => {
    const user = userEvent.setup()
    toon(client({ btw_regime: 'vrijgesteld_kleine_onderneming', btw_aangifte_frequentie: null }))
    const vakjes = screen.getAllByText(/Bijzondere btw-aangifte/i)
    expect(vakjes).toHaveLength(1)
    await user.click(screen.getByRole('checkbox', { name: /Bijzondere btw-aangifte/i }))
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        obligations: expect.arrayContaining([
          expect.objectContaining({ obligation_type_id: 'ot-bijz', gekozen: true }),
        ]),
      })
    )
  })

  it('verbergt ze bij een periodieke aangever', () => {
    toon(client({ btw_regime: 'periodieke_aangever' }))
    expect(screen.queryByText(/Bijzondere btw-aangifte/i)).not.toBeInTheDocument()
  })

  it('toont ze wel bij een periodieke aangever als ze al aanstaat', () => {
    // Zo kun je ze zelf uitvinken. Verbergen zou het opslaan laten stuklopen
    // op de databankregel, met een fout over iets wat nergens te zien is.
    toon(client({ btw_regime: 'periodieke_aangever' }), [
      { obligation_type_id: 'ot-bijz', gekozen: true },
    ])
    expect(screen.getByRole('checkbox', { name: /Bijzondere btw-aangifte/i })).toBeChecked()
  })
})


describe('ClientFormModal — het team van het dossier', () => {
  function toon(c: Client | null = null) {
    render(
      <ClientFormModal
        client={c}
        employees={employees}
        obligationTypes={obligationTypes}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
  }

  it('waarschuwt zolang er geen team gekozen is', async () => {
    // Een dossier zonder team is zichtbaar voor het hele kantoor. Dat is
    // bewust zo -- niets mag stil verdwijnen -- maar dan moet het scherm het
    // wel zeggen.
    toon()
    expect(await screen.findByText(/zichtbaar voor het hele kantoor/i)).toBeInTheDocument()
  })

  it('slaat het gekozen team op en laat de waarschuwing vallen', async () => {
    const user = userEvent.setup()
    toon()

    await user.selectOptions(await screen.findByLabelText('Team'), 't-zav1')
    expect(screen.queryByText(/zichtbaar voor het hele kantoor/i)).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Naam *'), 'Nieuwe klant')
    await user.click(screen.getByRole('button', { name: 'Opslaan' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ team_id: 't-zav1' }))
  })

  it('snoeit de keuzelijst met collega\'s tot het team van het dossier', async () => {
    // Geen afscherming -- dat doet de databank -- maar wel het verschil tussen
    // vijftig namen en de handvol die hier zinvol zijn.
    const user = userEvent.setup()
    toon()
    await user.selectOptions(await screen.findByLabelText('Team'), 't-aal')

    const keuze = screen.getByLabelText(/Standaard verantwoordelijke/) as HTMLSelectElement
    const namen = Array.from(keuze.querySelectorAll('option')).map((o) => o.textContent)
    expect(namen).toContain('Els Peeters')
    expect(namen).not.toContain('Jan Janssens')
  })
})
