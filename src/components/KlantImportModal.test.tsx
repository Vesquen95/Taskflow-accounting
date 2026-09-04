import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KlantImportModal } from './KlantImportModal'
import { KlantImportFout, type ImportRij, type ImportVoorbeeld, type NieuweKlant } from '../lib/klantImport'

const leesKlantenBestand = vi.fn()
const downloadSjabloon = vi.fn()

vi.mock('../lib/klantImportBestand', () => ({
  SJABLOON_BESTANDSNAAM: 'sjabloon.xlsx',
  leesKlantenBestand: (...args: unknown[]) => leesKlantenBestand(...args),
  downloadSjabloon: (...args: unknown[]) => downloadSjabloon(...args),
  bouwSjabloonBlob: vi.fn(),
}))

function klant(naam: string): NieuweKlant {
  return {
    naam,
    ondernemingsnummer: null,
    team_code: null,
    klantsoort: 'rechtspersoon' as const,
    rechtsvorm: 'BV',
    boekjaar_einde_maand: 12,
    boekjaar_einde_dag: 31,
    btw_regime: 'geen',
    btw_aangifte_frequentie: null,
    mandataris: false,
  }
}

function rij(excelRij: number, naam: string, fouten: string[] = []): ImportRij {
  return {
    excelRij,
    ruw: { naam } as ImportRij['ruw'],
    klant: fouten.length === 0 ? klant(naam) : null,
    fouten,
    waarschuwingen: [],
    verplichtingen: [],
  }
}

const VOORBEELD: ImportVoorbeeld = {
  bladnaam: 'Klanten',
  rijen: [rij(2, 'Acme BV'), rij(3, 'Beta NV'), rij(4, 'Gamma', ['BTW-regime "onzin" is geen geldige waarde.'])],
  aantalGeldig: 2,
  legeRijenOvergeslagen: 1,
  onbekendeKolommen: [],
}

const maakKlant = vi.fn()
const onKlaar = vi.fn()
const onClose = vi.fn()

function toon(props: Partial<React.ComponentProps<typeof KlantImportModal>> = {}) {
  return render(
    <KlantImportModal
      bestaandeOndernemingsnummers={[]}
      maakKlant={maakKlant}
      onKlaar={onKlaar}
      onClose={onClose}
      {...props}
    />
  )
}

async function kiesBestand() {
  const user = userEvent.setup()
  const file = new File(['x'], 'klanten.xlsx')
  await user.upload(screen.getByLabelText(/Excel-bestand/i), file)
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
  leesKlantenBestand.mockResolvedValue(VOORBEELD)
  maakKlant.mockResolvedValue('client-id')
})

describe('KlantImportModal — niets naar de databank zonder voorbeeld', () => {
  it('toont een voorbeeld van het bestand en slaat nog niets op', async () => {
    toon()
    await kiesBestand()

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('Acme BV')
    expect(screen.getByRole('table')).toHaveTextContent('Gamma')
    expect(maakKlant).not.toHaveBeenCalled()
  })

  it('zegt hoeveel rijen geldig zijn en importeert er enkel die', async () => {
    toon()
    const user = await kiesBestand()

    const knop = await screen.findByRole('button', { name: /2 klanten importeren/i })
    await user.click(knop)

    expect(maakKlant).toHaveBeenCalledTimes(2)
    expect(maakKlant.mock.calls.map((c) => (c[0] as NieuweKlant).naam)).toEqual(['Acme BV', 'Beta NV'])
  })

  it('zet bij elke fout het Excel-rijnummer', async () => {
    toon()
    await kiesBestand()

    const tabel = await screen.findByRole('table')
    const fouteRij = within(tabel).getByText(/BTW-regime "onzin"/).closest('tr')
    expect(fouteRij).not.toBeNull()
    expect(within(fouteRij as HTMLElement).getByText('4')).toBeInTheDocument()
  })

  it('laat niet importeren wanneer geen enkele rij geldig is', async () => {
    leesKlantenBestand.mockResolvedValue({
      ...VOORBEELD,
      rijen: [rij(2, 'Gamma', ['Naam is verplicht.'])],
      aantalGeldig: 0,
    })
    toon()
    await kiesBestand()

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /importeren/i })).not.toBeInTheDocument()
  })

  it('meldt overgeslagen lege rijen en onbekende kolommen', async () => {
    leesKlantenBestand.mockResolvedValue({ ...VOORBEELD, onbekendeKolommen: ['Interne code'] })
    toon()
    await kiesBestand()

    expect(await screen.findByRole('dialog')).toHaveTextContent('Interne code')
    expect(screen.getByRole('dialog')).toHaveTextContent(/lege rij/i)
  })
})

describe('KlantImportModal — verslag na de import', () => {
  it('meldt per rij wat er misging bij een gedeeltelijk geslaagde import', async () => {
    maakKlant.mockImplementation(async (k: NieuweKlant) => {
      if (k.naam === 'Beta NV') throw { code: '23505', message: 'ondernemingsnummer bestaat al' }
      return 'client-id'
    })
    toon()
    const user = await kiesBestand()
    await user.click(await screen.findByRole('button', { name: /2 klanten importeren/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/1 klant.*aangemaakt|1 van de 2/i)
    expect(dialog).toHaveTextContent('Rij 3')
    expect(dialog).toHaveTextContent(/ondernemingsnummer/i)
    expect(onKlaar).toHaveBeenCalledWith(1)
  })

  it('meldt een klant die er staat maar wiens verplichtingen niet gezet raakten', async () => {
    const zetVerplichtingen = vi.fn().mockRejectedValue({ code: '42501', message: 'geen toegang' })
    toon({ zetVerplichtingen })
    const user = await kiesBestand()
    await user.click(await screen.findByRole('button', { name: /2 klanten importeren/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('2 klanten aangemaakt')
    expect(dialog).toHaveTextContent(/verplichtingen en taken konden niet gezet worden/i)
    expect(dialog).toHaveTextContent('Rij 2')
  })

  it('toont een gelukte import zonder foutenlijst', async () => {
    toon()
    const user = await kiesBestand()
    await user.click(await screen.findByRole('button', { name: /2 klanten importeren/i }))

    expect(await screen.findByText(/2 klanten aangemaakt/i)).toBeInTheDocument()
    expect(onKlaar).toHaveBeenCalledWith(2)
  })
})

describe('KlantImportModal — sjabloon en foute bestanden', () => {
  it('heeft naast het importeren een knop om het sjabloon te downloaden', async () => {
    const user = userEvent.setup()
    toon()
    await user.click(screen.getByRole('button', { name: /sjabloon downloaden/i }))
    expect(downloadSjabloon).toHaveBeenCalledTimes(1)
  })

  it('toont de reden wanneer het bestand geweigerd wordt', async () => {
    leesKlantenBestand.mockRejectedValue(new KlantImportFout('Het bestand is groter dan 2 MB.'))
    toon()
    await kiesBestand()

    expect(await screen.findByRole('alert')).toHaveTextContent('groter dan 2 MB')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('KlantImportModal — het voorbeeld toont welke verplichtingen meekomen', () => {
  it('noemt per rij de aangevinkte verplichtingen', async () => {
    // Zonder deze kolom is het vinkje in Excel onzichtbaar tot na het opslaan,
    // en dan staat er al een dossier met de verkeerde deadlines in.
    leesKlantenBestand.mockResolvedValue({
      ...VOORBEELD,
      rijen: [
        {
          ...rij(2, 'Acme BV'),
          verplichtingen: [
            { code: 'algemene_vergadering' as const, parameters: { av_vorm: 'vaste_datum', av_maand: 5, av_dag: 15 } },
            { code: 'va_venb' as const, parameters: {} },
          ],
        },
      ],
      aantalGeldig: 1,
    })
    toon()
    await kiesBestand()

    const tabel = await screen.findByRole('table')
    expect(within(tabel).getByText(/Algemene vergadering/)).toBeInTheDocument()
    expect(within(tabel).getByText(/Voorafbetalingen/)).toBeInTheDocument()
  })

  it('toont ook de instellingen die het bestand meegaf', async () => {
    // Zonder dit zie je pas na het opslaan of "1 maand voor AV" ook echt zo
    // gelezen is -- en dan staat het dossier er al met de verkeerde deadline.
    leesKlantenBestand.mockResolvedValue({
      ...VOORBEELD,
      rijen: [
        {
          ...rij(2, 'Acme BV'),
          verplichtingen: [
            { code: 'jaarafsluiting' as const, parameters: { basis: 'voor_av', maanden_voor_av: 2 } },
            { code: 'rapportering' as const, parameters: { frequentie: 'maand', termijn_dagen: 15 } },
          ],
        },
      ],
      aantalGeldig: 1,
    })
    toon()
    await kiesBestand()

    const tabel = await screen.findByRole('table')
    expect(within(tabel).getByText(/2 mnd voor AV/)).toBeInTheDocument()
    expect(within(tabel).getByText(/maand, 15 d/)).toBeInTheDocument()
  })

  it('zegt het wanneer een rij geen enkele verplichting aanvinkt', async () => {
    leesKlantenBestand.mockResolvedValue({ ...VOORBEELD, rijen: [rij(2, 'Acme BV')], aantalGeldig: 1 })
    toon()
    await kiesBestand()

    const tabel = await screen.findByRole('table')
    expect(within(tabel).getByText(/^Geen$/)).toBeInTheDocument()
  })
})
