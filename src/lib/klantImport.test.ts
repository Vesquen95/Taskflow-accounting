import { describe, expect, it } from 'vitest'
import {
  KOLOMMEN,
  KlantImportFout,
  MAX_RIJEN,
  kiesBlad,
  leesKlantRijen,
  normaliseerOndernemingsnummer,
} from './klantImport'

const KOPPEN = KOLOMMEN.map((k) => k.kop)

/** Een geldige voorbeeldrij, in de kolomvolgorde van het sjabloon: eerst de
 *  velden van de klant, dan een cel per verplichting. */
const GOEDE_RIJ: unknown[] = [
  'Acme BV', 'BE0123.456.749', 'BV', 12, 31, 'Periodieke aangever', 'Kwartaal', 'Ja',
  'Ja', 'Ja', 'Ja', 'Ja', 'Nee', '', '', '',
]

/** Bouwt een bladmatrix: kopregel + de meegegeven rijen. */
function blad(...rijen: unknown[][]): unknown[][] {
  return [KOPPEN, ...rijen]
}

function metVeld(sleutel: string, waarde: unknown, basis: unknown[] = GOEDE_RIJ): unknown[] {
  const index = KOLOMMEN.findIndex((k) => k.sleutel === sleutel)
  if (index === -1) throw new Error(`onbekende kolom ${sleutel}`)
  const rij = [...basis]
  rij[index] = waarde
  return rij
}

describe('leesKlantRijen — een goed bestand', () => {
  it('levert precies de velden die naar de databank gaan', () => {
    const voorbeeld = leesKlantRijen(blad(GOEDE_RIJ))

    expect(voorbeeld.rijen).toHaveLength(1)
    const rij = voorbeeld.rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.excelRij).toBe(2)
    expect(rij.klant).toEqual({
      naam: 'Acme BV',
      ondernemingsnummer: 'BE0123.456.749',
      rechtsvorm: 'BV',
      boekjaar_einde_maand: 12,
      boekjaar_einde_dag: 31,
      btw_regime: 'periodieke_aangever',
      btw_aangifte_frequentie: 'kwartaal',
      mandataris: true,
    })
    expect(voorbeeld.aantalGeldig).toBe(1)
  })

  it('belooft nooit vertrouwelijk of een standaard verantwoordelijke — die weigert de databank bij aanmaak', () => {
    const rij = leesKlantRijen(blad(GOEDE_RIJ)).rijen[0]
    expect(Object.keys(rij.klant ?? {})).not.toContain('vertrouwelijk')
    expect(Object.keys(rij.klant ?? {})).not.toContain('standaard_verantwoordelijke_id')
    // Ook niet als kolom aan te bieden: dat zou een belofte zijn die
    // block_unaudited_confidentiality_change() bij de insert afwijst.
    expect(KOLOMMEN.map((k) => k.sleutel)).not.toContain('vertrouwelijk')
    expect(KOLOMMEN.map((k) => k.sleutel)).not.toContain('standaard_verantwoordelijke_id')
  })

  it('leest lege optionele velden als null in plaats van als lege tekst', () => {
    const rij = leesKlantRijen(blad(metVeld('rechtsvorm', '', metVeld('ondernemingsnummer', '')))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.ondernemingsnummer).toBeNull()
    expect(rij.klant?.rechtsvorm).toBeNull()
  })
})

describe('leesKlantRijen — lege rijen', () => {
  it('slaat een lege rij onderaan over zonder er een fout van te maken', () => {
    const voorbeeld = leesKlantRijen(blad(GOEDE_RIJ, [], [null, null, null, null, null, null, null, null], ['', '   ']))
    expect(voorbeeld.rijen).toHaveLength(1)
    expect(voorbeeld.legeRijenOvergeslagen).toBe(3)
  })

  it('houdt de Excel-rijnummers kloppend wanneer er tussenin een lege rij staat', () => {
    const voorbeeld = leesKlantRijen(blad(GOEDE_RIJ, [], metVeld('naam', 'Beta NV')))
    expect(voorbeeld.rijen.map((r) => r.excelRij)).toEqual([2, 4])
  })

  it('telt een rij met enkel een ondernemingsnummer niet als leeg', () => {
    const voorbeeld = leesKlantRijen(blad(['', 'BE0123.456.749']))
    expect(voorbeeld.rijen).toHaveLength(1)
    expect(voorbeeld.rijen[0].fouten.join(' ')).toMatch(/naam/i)
  })
})

describe('leesKlantRijen — waarden die de databank zou weigeren', () => {
  it('wijst een onbekende btw-regimewaarde af en noemt wat wél mag', () => {
    const rij = leesKlantRijen(blad(metVeld('btw_regime', 'periodiek?'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten).toHaveLength(1)
    expect(rij.fouten[0]).toMatch(/BTW-regime/i)
    expect(rij.fouten[0]).toContain('Periodieke aangever')
    expect(rij.fouten[0]).toContain('periodiek?')
  })

  it('wijst een onbekende aangiftefrequentie af', () => {
    const rij = leesKlantRijen(blad(metVeld('btw_aangifte_frequentie', 'jaarlijks'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten[0]).toMatch(/frequentie/i)
    expect(rij.fouten[0]).toContain('Kwartaal')
  })

  // clients_btw_freq_only_when_periodiek (migratie 0003)
  it('eist een frequentie bij een periodieke aangever', () => {
    const rij = leesKlantRijen(blad(metVeld('btw_aangifte_frequentie', ''))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/frequentie/i)
  })

  it('weigert een frequentie bij een regime dat er geen mag hebben', () => {
    const rij = leesKlantRijen(blad(metVeld('btw_regime', 'Geen'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/enkel|alleen/i)
  })

  it('laat een niet-periodiek regime zonder frequentie gewoon door', () => {
    const rij = leesKlantRijen(
      blad(metVeld('btw_aangifte_frequentie', '', metVeld('btw_regime', 'Vrijgesteld (kleine onderneming)')))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.btw_regime).toBe('vrijgesteld_kleine_onderneming')
    expect(rij.klant?.btw_aangifte_frequentie).toBeNull()
  })

  it('weigert een lege naam', () => {
    const rij = leesKlantRijen(blad(metVeld('naam', '   '))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/naam/i)
  })

  it('weigert een naam langer dan de 200 tekens van de databank', () => {
    const rij = leesKlantRijen(blad(metVeld('naam', 'A'.repeat(201)))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/200/)
  })

  it('weigert een rechtsvorm langer dan 100 tekens', () => {
    const rij = leesKlantRijen(blad(metVeld('rechtsvorm', 'B'.repeat(101)))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/100/)
  })

  // unique (firm_id, ondernemingsnummer) — één insert per rij, dus de tweede
  // zou falen op 23505. Dat hoort het kantoor te zien vóór het opslaat.
  it('markeert een ondernemingsnummer dat twee keer in het bestand staat', () => {
    const voorbeeld = leesKlantRijen(blad(GOEDE_RIJ, metVeld('naam', 'Beta NV')))
    expect(voorbeeld.rijen[0].fouten).toEqual([])
    expect(voorbeeld.rijen[1].klant).toBeNull()
    expect(voorbeeld.rijen[1].fouten.join(' ')).toMatch(/rij 2/i)
  })

  it('markeert een ondernemingsnummer dat al bij een bestaande klant hoort', () => {
    const voorbeeld = leesKlantRijen(blad(GOEDE_RIJ), { bestaandeOndernemingsnummers: ['0123456749'] })
    expect(voorbeeld.rijen[0].klant).toBeNull()
    expect(voorbeeld.rijen[0].fouten.join(' ')).toMatch(/bestaat al/i)
  })
})

describe('leesKlantRijen — normaliseren wat veilig te normaliseren is', () => {
  it('maakt van een ondernemingsnummer in allerlei schrijfwijzen één vorm', () => {
    expect(normaliseerOndernemingsnummer('BE0123.456.749')).toBe('BE0123.456.749')
    expect(normaliseerOndernemingsnummer('0123456749')).toBe('BE0123.456.749')
    expect(normaliseerOndernemingsnummer(' be 0123 456 749 ')).toBe('BE0123.456.749')
    expect(normaliseerOndernemingsnummer('BE 0123-456-749')).toBe('BE0123.456.749')
  })

  it('herstelt de nul die Excel van een getalcel afknipt', () => {
    // 0123456749 in een getalcel komt binnen als 123456749.
    const rij = leesKlantRijen(blad(metVeld('ondernemingsnummer', 123456749))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.ondernemingsnummer).toBe('BE0123.456.749')
  })

  it('weigert een ondernemingsnummer dat geen Belgisch nummer kan zijn', () => {
    expect(normaliseerOndernemingsnummer('12345')).toBeNull()
    expect(normaliseerOndernemingsnummer('BE9123456749')).toBeNull()
    const rij = leesKlantRijen(blad(metVeld('ondernemingsnummer', 'niet echt'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/ondernemingsnummer/i)
  })

  it('waarschuwt over een fout controlegetal zonder de rij te blokkeren', () => {
    const rij = leesKlantRijen(blad(metVeld('ondernemingsnummer', 'BE0123.456.789'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.ondernemingsnummer).toBe('BE0123.456.789')
    expect(rij.waarschuwingen.join(' ')).toMatch(/controlegetal/i)
  })

  it('leest getallen die als tekst binnenkomen', () => {
    const rij = leesKlantRijen(blad(metVeld('boekjaar_einde_maand', ' 6 ', metVeld('boekjaar_einde_dag', '30')))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.boekjaar_einde_maand).toBe(6)
    expect(rij.klant?.boekjaar_einde_dag).toBe(30)
  })

  it('leest een maandnaam', () => {
    const rij = leesKlantRijen(blad(metVeld('boekjaar_einde_maand', 'juni', metVeld('boekjaar_einde_dag', 30)))).rijen[0]
    expect(rij.klant?.boekjaar_einde_maand).toBe(6)
  })

  it('leest Ja/Nee, waar/onwaar en een echte booleaanse cel als mandataris', () => {
    const jas = ['Ja', 'ja', 'JA', true, 1, 'waar'].map(
      (w) => leesKlantRijen(blad(metVeld('mandataris', w))).rijen[0]
    )
    expect(jas.every((r) => r.klant?.mandataris === true)).toBe(true)

    const nees = ['Nee', 'neen', false, 0, ''].map((w) => leesKlantRijen(blad(metVeld('mandataris', w))).rijen[0])
    expect(nees.every((r) => r.klant?.mandataris === false)).toBe(true)
  })

  it('weigert een mandatariswaarde waarvan je moet gokken', () => {
    const rij = leesKlantRijen(blad(metVeld('mandataris', 'soms'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/mandataris/i)
  })
})

describe('leesKlantRijen — boekjaareinde', () => {
  it('neemt 31/12 aan wanneer beide velden leeg zijn, en zegt dat', () => {
    const rij = leesKlantRijen(blad(metVeld('boekjaar_einde_maand', '', metVeld('boekjaar_einde_dag', '')))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.boekjaar_einde_maand).toBe(12)
    expect(rij.klant?.boekjaar_einde_dag).toBe(31)
    expect(rij.waarschuwingen.join(' ')).toMatch(/31\/12/)
  })

  it('vult niets aan wanneer maar één van de twee ingevuld is', () => {
    const rij = leesKlantRijen(blad(metVeld('boekjaar_einde_maand', '', metVeld('boekjaar_einde_dag', 30)))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/boekjaareinde/i)
  })

  it('weigert een maand buiten 1-12 en een dag buiten 1-31', () => {
    expect(leesKlantRijen(blad(metVeld('boekjaar_einde_maand', 13))).rijen[0].klant).toBeNull()
    expect(leesKlantRijen(blad(metVeld('boekjaar_einde_dag', 0))).rijen[0].klant).toBeNull()
    expect(leesKlantRijen(blad(metVeld('boekjaar_einde_dag', 32))).rijen[0].klant).toBeNull()
  })

  it('weigert een dag die in die maand niet bestaat', () => {
    const rij = leesKlantRijen(blad(metVeld('boekjaar_einde_maand', 2, metVeld('boekjaar_einde_dag', 31)))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/februari/i)
  })
})

describe('leesKlantRijen — een bestand dat helemaal niet klopt', () => {
  it('weigert een blad zonder rijen', () => {
    expect(() => leesKlantRijen([])).toThrow(KlantImportFout)
  })

  it('weigert een blad zonder de verplichte kopregel en noemt wat ontbreekt', () => {
    expect(() => leesKlantRijen([['Voornaam', 'Achternaam'], ['Jan', 'Peeters']])).toThrow(/Naam/)
  })

  it('meldt onbekende kolommen maar leest de rest gewoon', () => {
    const voorbeeld = leesKlantRijen([
      [...KOPPEN, 'Interne code'],
      [...GOEDE_RIJ, 'X-42'],
    ])
    expect(voorbeeld.onbekendeKolommen).toEqual(['Interne code'])
    expect(voorbeeld.rijen[0].fouten).toEqual([])
  })

  it('vindt de kopregel ook als er lege rijen boven staan', () => {
    const voorbeeld = leesKlantRijen([[], [], KOPPEN, GOEDE_RIJ])
    expect(voorbeeld.rijen[0].excelRij).toBe(4)
  })

  it('weigert een bestand met te veel rijen in plaats van het scherm te laten vastlopen', () => {
    const teveel = Array.from({ length: MAX_RIJEN + 1 }, (_, i) => metVeld('naam', `Klant ${i}`, metVeld('ondernemingsnummer', '')))
    expect(() => leesKlantRijen(blad(...teveel))).toThrow(KlantImportFout)
    expect(() => leesKlantRijen(blad(...teveel))).toThrow(new RegExp(String(MAX_RIJEN)))
  })

  it('kort een absurd lange celwaarde in voor ze in een foutmelding belandt', () => {
    const rij = leesKlantRijen(blad(metVeld('btw_regime', 'x'.repeat(5000)))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten[0].length).toBeLessThan(300)
    expect(rij.fouten[0]).toContain('…')
  })

  it('maakt van rommel in elke cel nette fouten in plaats van een crash', () => {
    const rommel = [new Date(2024, 1, 1), { iets: 'raars' }, ['lijst'], NaN, Infinity, new Date(), null, 'misschien']
    const voorbeeld = leesKlantRijen(blad(rommel as unknown[]))
    expect(voorbeeld.rijen[0].klant).toBeNull()
    expect(voorbeeld.rijen[0].fouten.length).toBeGreaterThan(0)
    expect(voorbeeld.aantalGeldig).toBe(0)
  })
})

describe('kiesBlad', () => {
  it('kiest het blad Klanten, ook als het niet vooraan staat', () => {
    const gekozen = kiesBlad([
      { sheet: 'Toelichting', data: [['uitleg']] },
      { sheet: 'Klanten', data: [KOPPEN] },
    ])
    expect(gekozen.sheet).toBe('Klanten')
  })

  it('valt terug op het eerste blad wanneer er geen blad Klanten is', () => {
    const gekozen = kiesBlad([
      { sheet: 'Blad1', data: [KOPPEN] },
      { sheet: 'Blad2', data: [] },
    ])
    expect(gekozen.sheet).toBe('Blad1')
  })

  it('weigert een werkboek zonder bladen', () => {
    expect(() => kiesBlad([])).toThrow(KlantImportFout)
  })
})

describe('leesKlantRijen — de verplichtingen per klant', () => {
  it('geeft de aangevinkte verplichtingen terug als code', () => {
    // De reden dat deze kolommen bestaan: anders moet elk geïmporteerd
    // dossier daarna nog één voor één opengezet worden.
    const rij = leesKlantRijen(blad(GOEDE_RIJ)).rijen[0]
    expect(rij.verplichtingen).toEqual([
      'algemene_vergadering',
      'jaarafsluiting',
      'aangifte_venb_pb',
      'va_venb',
    ])
  })

  it('telt een lege cel als Nee', () => {
    const rij = leesKlantRijen(blad(metVeld('algemene_vergadering', ''))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen).not.toContain('algemene_vergadering')
  })

  it('aanvaardt de gebruikelijke schrijfwijzen voor ja', () => {
    for (const waarde of ['ja', 'JA', 'x', 'X', 1, true]) {
      const rij = leesKlantRijen(blad(metVeld('rapportering', waarde))).rijen[0]
      expect(rij.fouten).toEqual([])
      expect(rij.verplichtingen).toContain('rapportering')
    }
  })

  it('maakt van een onleesbare cel een fout en niet stilzwijgend een Nee', () => {
    // Bij een wettelijke verplichting is "we hebben het maar overgeslagen" de
    // slechtste uitkomst: dan mist het dossier een deadline zonder dat iemand
    // het merkt.
    const rij = leesKlantRijen(blad(metVeld('fiche_281_50', 'misschien'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toContain('Fiche 281.50')
    expect(rij.fouten.join(' ')).toMatch(/Ja of Nee/i)
  })

  it('biedt geen kolom aan voor iets wat de databank zelf beheert', () => {
    const sleutels = KOLOMMEN.map((k) => k.sleutel)
    // btw_aangifte en btw_klantenlisting volgen uit het btw-regime
    // (sync_btw_obligations); de neerlegging hangt aan de AV en wordt door de
    // motor meegemaakt. Een kolom ervoor zou een vinkje zijn dat niets doet.
    expect(sleutels).not.toContain('btw_aangifte')
    expect(sleutels).not.toContain('btw_klantenlisting')
    expect(sleutels).not.toContain('neerlegging_jaarrekening')
  })

  it('leest een oud bestand zonder verplichtingskolommen gewoon in', () => {
    // Wie het sjabloon van vóór deze uitbreiding gebruikt, mag niet stranden:
    // die klanten komen binnen zonder verplichtingen, precies zoals voorheen.
    const oudeKoppen = KOLOMMEN.filter((k) => !k.verplichting).map((k) => k.kop)
    const voorbeeld = leesKlantRijen([oudeKoppen, GOEDE_RIJ.slice(0, oudeKoppen.length)])
    expect(voorbeeld.rijen[0].fouten).toEqual([])
    expect(voorbeeld.rijen[0].verplichtingen).toEqual([])
  })
})
