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

/**
 * Een geldige voorbeeldrij.
 *
 * Op sleutel en niet op positie. Dit stond hier eerst als een platte lijst in
 * kolomvolgorde, en die brak bij elke nieuwe kolom: alles achter de invoegplek
 * schoof op, en dan komt "15/05" plots in de fichekolom terecht. Drie keer
 * gebeurd. Zo gebeurt het niet meer -- en een kolom zonder waarde hier valt
 * meteen op als lege cel in plaats van als verschoven waarde.
 */
const RIJ_PER_KOLOM: Record<string, unknown> = {
  naam: 'Acme BV',
  klantsoort: 'Rechtspersoon',
  team: 'ZAV1',
  ondernemingsnummer: 'BE0123.456.749',
  rechtsvorm: 'BV',
  boekjaar_einde_maand: 12,
  boekjaar_einde_dag: 31,
  btw_regime: 'Periodieke aangever',
  btw_aangifte_frequentie: 'Kwartaal',
  mandataris: 'Ja',
  algemene_vergadering: 'Ja',
  jaarafsluiting: 'Ja',
  aangifte_venb_pb: 'Ja',
  aangifte_rpb: 'Nee',
  va_venb: 'Ja',
  aangifte_pb: 'Nee',
  patrimoniumtaks: 'Nee',
  ubo_bevestiging: 'Nee',
  ic_opgave: 'Nee',
  btw_bijzondere_aangifte: 'Nee',
  rapportering: 'Nee',
  fiche_281_20: '',
  fiche_281_45: '',
  fiche_281_50: '',
  av_datum: '15/05',
  jaarafsluiting_deadline: '1 maand voor AV',
  pb_vorm: '',
  rapportering_frequentie: '',
  rapportering_termijn: '',
}

const GOEDE_RIJ: unknown[] = KOLOMMEN.map((k) => {
  if (!(k.sleutel in RIJ_PER_KOLOM)) {
    throw new Error(
      `De voorbeeldrij mist kolom "${k.sleutel}". Vul ze aan in RIJ_PER_KOLOM.`
    )
  }
  return RIJ_PER_KOLOM[k.sleutel]
})

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
      klantsoort: 'rechtspersoon',
      team_code: 'ZAV1',
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
    // Ook de AV-datum meeveranderen: 15/05 valt buiten de wettelijke zes
    // maanden zodra het boekjaar op 30/06 eindigt, en dat is terecht.
    const rij = leesKlantRijen(
      blad(metVeld('boekjaar_einde_maand', ' 6 ', metVeld('boekjaar_einde_dag', '30', metVeld('av_datum', ''))))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.boekjaar_einde_maand).toBe(6)
    expect(rij.klant?.boekjaar_einde_dag).toBe(30)
  })

  it('leest een maandnaam', () => {
    const rij = leesKlantRijen(
      blad(metVeld('boekjaar_einde_maand', 'juni', metVeld('boekjaar_einde_dag', 30, metVeld('av_datum', ''))))
    ).rijen[0]
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

  it('weigert een waarde voor het fiscaal mandaat waarvan je moet gokken', () => {
    const rij = leesKlantRijen(blad(metVeld('mandataris', 'soms'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/fiscaal mandaat/i)
  })

  it('leest de kolom nog steeds wanneer ze "Mandataris" heet', () => {
    // Het veld heette tot vandaag zo. Wie een bestand van vorige week
    // opnieuw gebruikt, mag daar niet op stranden.
    const oudeKoppen = KOLOMMEN.map((k) => (k.sleutel === 'mandataris' ? 'Mandataris' : k.kop))
    const voorbeeld = leesKlantRijen([oudeKoppen, GOEDE_RIJ])
    expect(voorbeeld.onbekendeKolommen).toEqual([])
    expect(voorbeeld.rijen[0].fouten).toEqual([])
    expect(voorbeeld.rijen[0].klant?.mandataris).toBe(true)
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
    expect(rij.verplichtingen.map((v) => v.code)).toEqual([
      'algemene_vergadering',
      'jaarafsluiting',
      'aangifte_venb_pb',
      'va_venb',
    ])
  })

  it('telt een lege cel als Nee', () => {
    // De voorbeeldrij laat de jaarafsluiting vanaf de AV rekenen; zonder AV
    // hoort dat een fout te zijn, dus zet die deadline hier op maanden na het
    // boekjaareinde. Wat deze test bewaakt is de lege cel, niet die koppeling.
    const rij = leesKlantRijen(
      blad(metVeld('algemene_vergadering', '', metVeld('av_datum', '',
        metVeld('jaarafsluiting_deadline', '3'))))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.map((v) => v.code)).not.toContain('algemene_vergadering')
  })

  it('aanvaardt de gebruikelijke schrijfwijzen voor ja', () => {
    for (const waarde of ['ja', 'JA', 'x', 'X', 1, true]) {
      const rij = leesKlantRijen(blad(metVeld('rapportering', waarde))).rijen[0]
      expect(rij.fouten).toEqual([])
      expect(rij.verplichtingen.map((v) => v.code)).toContain('rapportering')
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
    const oudeKoppen = KOLOMMEN.filter((k) => !k.verplichting && !k.instelling).map((k) => k.kop)
    const voorbeeld = leesKlantRijen([oudeKoppen, GOEDE_RIJ.slice(0, oudeKoppen.length)])
    expect(voorbeeld.rijen[0].fouten).toEqual([])
    expect(voorbeeld.rijen[0].verplichtingen).toEqual([])
  })
})

describe('leesKlantRijen — de instellingen per verplichting', () => {
  function keuze(rij: ReturnType<typeof leesKlantRijen>['rijen'][number], code: string) {
    return rij.verplichtingen.find((v) => v.code === code)
  }

  it('leest een vaste statutaire AV-datum', () => {
    const rij = leesKlantRijen(blad(metVeld('av_datum', '15/05'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(keuze(rij, 'algemene_vergadering')?.parameters).toEqual({
      av_vorm: 'vaste_datum',
      av_maand: 5,
      av_dag: 15,
    })
  })

  it('leest een datum met een maandnaam en met verschillende scheidingstekens', () => {
    for (const waarde of ['15 mei', '15-5', '15.5', '15 5']) {
      const rij = leesKlantRijen(blad(metVeld('av_datum', waarde))).rijen[0]
      expect(rij.fouten).toEqual([])
      expect(keuze(rij, 'algemene_vergadering')?.parameters).toMatchObject({ av_maand: 5, av_dag: 15 })
    }
  })

  it('leest een n-de weekdag', () => {
    const rij = leesKlantRijen(blad(metVeld('av_datum', 'eerste maandag van juni'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(keuze(rij, 'algemene_vergadering')?.parameters).toEqual({
      av_vorm: 'nde_weekdag',
      av_rang: 'eerste',
      av_weekdag: 'maandag',
      av_maand: 6,
    })
  })

  it('leest ook "laatste vrijdag van mei"', () => {
    const rij = leesKlantRijen(blad(metVeld('av_datum', 'laatste vrijdag van mei'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(keuze(rij, 'algemene_vergadering')?.parameters).toMatchObject({
      av_rang: 'laatste',
      av_weekdag: 'vrijdag',
      av_maand: 5,
    })
  })

  it('weigert een AV-datum die niet bestaat', () => {
    const rij = leesKlantRijen(blad(metVeld('av_datum', '31/04'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/bestaat niet/i)
  })

  // enforce_av_parameters() weigert dit ook. Het hier al zeggen scheelt een
  // rij die er in het voorbeeld geldig uitziet en pas bij het opslaan sneuvelt.
  it('weigert een AV die buiten de wettelijke zes maanden valt', () => {
    const rij = leesKlantRijen(blad(metVeld('av_datum', '15/09'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/zes maanden/i)
  })

  it('laat een AV zonder statutaire datum gewoon door', () => {
    // Bewust geen standaarddatum verzinnen: de motor valt dan terug op de
    // wettelijke uiterste datum, net als in het klantformulier.
    const rij = leesKlantRijen(blad(metVeld('av_datum', ''))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(keuze(rij, 'algemene_vergadering')?.parameters).toEqual({})
  })

  it('leest de jaarafsluiting vóór de algemene vergadering', () => {
    for (const waarde of ['1 maand voor AV', 'voor av 1', '1 voor AV']) {
      const rij = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', waarde))).rijen[0]
      expect(rij.fouten).toEqual([])
      expect(keuze(rij, 'jaarafsluiting')?.parameters).toEqual({ basis: 'voor_av', maanden_voor_av: 1 })
    }
  })

  it('neemt één maand aan wanneer "voor AV" zonder getal staat', () => {
    const rij = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', 'voor AV'))).rijen[0]
    expect(keuze(rij, 'jaarafsluiting')?.parameters).toEqual({ basis: 'voor_av', maanden_voor_av: 1 })
  })

  it('leest een doorlooptijd na het boekjaareinde', () => {
    for (const waarde of ['3', '3 maanden', '3 maanden na boekjaareinde']) {
      const rij = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', waarde))).rijen[0]
      expect(rij.fouten).toEqual([])
      expect(keuze(rij, 'jaarafsluiting')?.parameters).toEqual({ basis: 'boekjaar', sla_maanden: 3 })
    }
  })

  // Dezelfde grenzen als enforce_jaarafsluiting_parameters() (migratie 0029).
  it('houdt zich aan de grenzen die de databank ook afdwingt', () => {
    const teVeelVoorAv = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', '9 maanden voor AV'))).rijen[0]
    expect(teVeelVoorAv.klant).toBeNull()
    expect(teVeelVoorAv.fouten.join(' ')).toMatch(/tussen 1 en 6/)

    const teVeelNaBoekjaar = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', '18'))).rijen[0]
    expect(teVeelNaBoekjaar.klant).toBeNull()
    expect(teVeelNaBoekjaar.fouten.join(' ')).toMatch(/tussen 1 en 12/)
  })

  it('leest de rapporteringsfrequentie en -termijn', () => {
    const rij = leesKlantRijen(
      blad(
        metVeld('rapportering', 'Ja',
          metVeld('rapportering_frequentie', 'Maand', metVeld('rapportering_termijn', 15)))
      )
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(keuze(rij, 'rapportering')?.parameters).toEqual({ frequentie: 'maand', termijn_dagen: 15 })
  })

  it('weigert een rapporteringstermijn die geen aantal dagen is', () => {
    const rij = leesKlantRijen(
      blad(metVeld('rapportering', 'Ja', metVeld('rapportering_termijn', 'snel')))
    ).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/dagen/i)
  })

  // Anders staat er een instelling in het bestand die nergens werkt, en dat
  // merk je pas als de deadline er maanden later naast blijkt te zitten.
  it('weigert een instelling zonder de bijhorende verplichting', () => {
    const rij = leesKlantRijen(
      blad(metVeld('rapportering_frequentie', 'Maand'))
    ).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/Rapportering.*op Nee staat/i)
  })

  it('laat lege instellingen de standaardwaarden houden', () => {
    // Het bestand geeft alleen mee wat er echt stond; de standaarden komen er
    // bij het opslaan bij, langs dezelfde helper als het klantformulier.
    const rij = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', ''))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(keuze(rij, 'jaarafsluiting')?.parameters).toEqual({})
  })
})

describe('leesKlantRijen — de aangifte RPB', () => {
  it('leest de RPB als eigen verplichting', () => {
    const rij = leesKlantRijen(
      blad(metVeld('aangifte_rpb', 'Ja',
        metVeld('aangifte_venb_pb', 'Nee', metVeld('va_venb', 'Nee'))))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.map((v) => v.code)).toContain('aangifte_rpb')
  })

  // Het kantoor: "als je RPB aanduidt is het beter om geen VA's aan te
  // bieden". De voorafbetalingen horen bij de vennootschapsbelasting.
  it('weigert voorafbetalingen naast de RPB', () => {
    const rij = leesKlantRijen(
      blad(metVeld('aangifte_rpb', 'Ja', metVeld('aangifte_venb_pb', 'Nee')))
    ).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/Voorafbetalingen horen bij de vennootschapsbelasting/i)
  })

  it('laat voorafbetalingen wél toe naast de VenB', () => {
    const rij = leesKlantRijen(blad(GOEDE_RIJ)).rijen[0]
    expect(rij.fouten).toEqual([])
    const codes = rij.verplichtingen.map((v) => v.code)
    expect(codes).toContain('aangifte_venb_pb')
    expect(codes).toContain('va_venb')
  })

  // De databank weigert dit ook (migratie 0034). Het hier al zeggen scheelt
  // een rij die er in het voorbeeld geldig uitziet en pas bij het opslaan
  // sneuvelt.
  it('weigert een klant met zowel VenB als RPB', () => {
    const rij = leesKlantRijen(blad(metVeld('aangifte_rpb', 'Ja'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/niet onder allebei/i)
  })

  it('laat een dossier zonder van beide gewoon door', () => {
    const rij = leesKlantRijen(blad(metVeld('aangifte_venb_pb', 'Nee'))).rijen[0]
    expect(rij.fouten).toEqual([])
    const codes = rij.verplichtingen.map((v) => v.code)
    expect(codes).not.toContain('aangifte_venb_pb')
    expect(codes).not.toContain('aangifte_rpb')
  })
})

describe('leesKlantRijen — soort dossier en de aangifte personenbelasting', () => {
  it('leest "Natuurlijke persoon" en de gebruikelijke schrijfwijzen', () => {
    for (const geschreven of ['Natuurlijke persoon', 'natuurlijk persoon', 'Eenmanszaak', 'Vrij beroep']) {
      const rij = leesKlantRijen(blad(metVeld('klantsoort', geschreven))).rijen[0]
      expect(rij.fouten).toEqual([])
      expect(rij.klant?.klantsoort).toBe('natuurlijk_persoon')
    }
  })

  it('telt een lege cel als rechtspersoon', () => {
    // Dat is wat elk bestaand dossier is, en wat een bestand zonder deze kolom
    // bedoelde. Een lege cel mag geen rij blokkeren.
    const rij = leesKlantRijen(blad(metVeld('klantsoort', ''))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.klantsoort).toBe('rechtspersoon')
  })

  it('weigert een soort die niet bestaat', () => {
    const rij = leesKlantRijen(blad(metVeld('klantsoort', 'VOF-achtig'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/Rechtspersoon.*Natuurlijke persoon/i)
  })

  it('leest de PB-aangifte met haar termijn', () => {
    const rij = leesKlantRijen(
      blad(
        metVeld('aangifte_venb_pb', 'Nee',
          metVeld('va_venb', 'Nee',
            metVeld('aangifte_pb', 'Ja', metVeld('pb_vorm', 'Eenvoudig'))))
      )
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.find((v) => v.code === 'aangifte_pb')?.parameters).toEqual({
      aangifte_vorm: 'eenvoudig',
    })
  })

  it('weigert de PB naast een aangifte VenB', () => {
    const rij = leesKlantRijen(blad(metVeld('aangifte_pb', 'Ja'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/niet onder twee/i)
  })

  it('weigert een termijn zonder aangevinkte PB-aangifte', () => {
    const rij = leesKlantRijen(blad(metVeld('pb_vorm', 'Complex'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/Aangifte PB/i)
  })
})

describe('leesKlantRijen — het team', () => {
  const CODES = ['AAL', 'ZAV1', 'ZAV2', 'ZAV3', 'ANT', 'GOS']

  it('leest de teamcode en zet ze in hoofdletters', () => {
    const rij = leesKlantRijen(blad(metVeld('team', ' zav2 ')), { teamCodes: CODES }).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.team_code).toBe('ZAV2')
  })

  it('weigert een team dat niet bestaat, en noemt de teams die wel bestaan', () => {
    // Stil negeren zou een dossier zonder team opleveren, en dat is er precies
    // één dat het hele kantoor te zien krijgt.
    const rij = leesKlantRijen(blad(metVeld('team', 'ZAV4')), { teamCodes: CODES }).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/ZAV4/)
    expect(rij.fouten.join(' ')).toMatch(/AAL, ZAV1/)
  })

  it('laat de cel leeg als het dossier nog niet ingedeeld is', () => {
    const rij = leesKlantRijen(blad(metVeld('team', '')), { teamCodes: CODES }).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.team_code).toBeNull()
  })

  it('laat de code staan wanneer het scherm de teams niet meegaf', () => {
    // De lezer kent de databank niet; zonder lijst valt er niets te toetsen en
    // is weigeren erger dan doorlaten.
    const rij = leesKlantRijen(blad(metVeld('team', 'XYZ'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.klant?.team_code).toBe('XYZ')
  })
})

describe('leesKlantRijen — de jaarafsluiting voor een vergadering die er niet is', () => {
  it('weigert "voor AV" wanneer de algemene vergadering op Nee staat', () => {
    const rij = leesKlantRijen(
      blad(metVeld('algemene_vergadering', 'Nee', metVeld('jaarafsluiting_deadline', '1 maand voor AV')))
    ).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/Algemene vergadering.*Nee/i)
  })

  it('laat "voor AV" gewoon door zodra de vergadering aangevinkt is', () => {
    const rij = leesKlantRijen(blad(metVeld('jaarafsluiting_deadline', '1 maand voor AV'))).rijen[0]
    expect(rij.fouten).toEqual([])
  })
})

describe('leesKlantRijen — patrimoniumtaks en bijzondere btw-aangifte', () => {
  it('leest ze als eigen verplichtingen', () => {
    const rij = leesKlantRijen(
      blad(metVeld('rechtsvorm', 'VZW', metVeld('patrimoniumtaks', 'Ja', metVeld('btw_bijzondere_aangifte', 'Ja',
        metVeld('btw_regime', 'Vrijgesteld (kleine onderneming)', metVeld('btw_aangifte_frequentie', ''))))))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    const codes = rij.verplichtingen.map((v) => v.code)
    expect(codes).toContain('patrimoniumtaks')
    expect(codes).toContain('btw_bijzondere_aangifte')
  })

  // De databank weigert dit ook: de bijzondere aangifte bestaat juist voor wie
  // géén periodieke aangifte indient.
  it('weigert de bijzondere aangifte bij een periodieke aangever', () => {
    const rij = leesKlantRijen(blad(metVeld('btw_bijzondere_aangifte', 'Ja'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/periodieke aangever/i)
  })

  // Dezelfde regel als in het klantenscherm: bij een vennootschap staat de
  // patrimoniumtaks er niet, dus mag de import ze ook niet stilzwijgend zetten.
  it('weigert de patrimoniumtaks bij een vennootschap', () => {
    const rij = leesKlantRijen(blad(metVeld('patrimoniumtaks', 'Ja'))).rijen[0]
    expect(rij.klant).toBeNull()
    expect(rij.fouten.join(' ')).toMatch(/patrimoniumtaks/i)
  })

  // Niet weten is geen reden om een wettelijke taks weg te laten: bij een
  // rechtsvorm die we niet herkennen laat de import ze staan.
  it('laat de patrimoniumtaks staan bij een onbekende rechtsvorm', () => {
    const rij = leesKlantRijen(
      blad(metVeld('rechtsvorm', 'Buitenlandse entiteit', metVeld('patrimoniumtaks', 'Ja')))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.map((v) => v.code)).toContain('patrimoniumtaks')
  })
})

describe('leesKlantRijen — het UBO-register', () => {
  it('neemt de bevestiging mee voor een vennootschap', () => {
    const rij = leesKlantRijen(blad(metVeld('ubo_bevestiging', 'Ja'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.map((v) => v.code)).toContain('ubo_bevestiging')
  })

  it('neemt ze mee voor een vzw', () => {
    const rij = leesKlantRijen(
      blad(metVeld('rechtsvorm', 'VZW', metVeld('ubo_bevestiging', 'Ja')))
    ).rijen[0]
    expect(rij.verplichtingen.map((v) => v.code)).toContain('ubo_bevestiging')
  })

  it('weigert ze bij een eenmanszaak, met de reden erbij', () => {
    // Er is geen entiteit om achter te kijken: de ondernemer ís de
    // natuurlijke persoon.
    const rij = leesKlantRijen(
      blad(metVeld('rechtsvorm', 'Eenmanszaak', metVeld('ubo_bevestiging', 'Ja')))
    ).rijen[0]
    expect(rij.fouten.join(' ')).toMatch(/eenmanszaak is niet informatieplichtig/i)
  })

  it('weigert ze bij een natuurlijke persoon', () => {
    const rij = leesKlantRijen(
      blad(metVeld('klantsoort', 'Natuurlijke persoon', metVeld('ubo_bevestiging', 'Ja')))
    ).rijen[0]
    expect(rij.fouten.join(' ')).toMatch(/natuurlijke persoon/i)
  })

  it('laat ze staan bij een rechtsvorm die het sjabloon niet kent', () => {
    // Zo goed als elke rechtspersoon is informatieplichtig; niet weten is geen
    // reden om een wettelijke verplichting stil weg te laten.
    const rij = leesKlantRijen(
      blad(metVeld('rechtsvorm', 'Buitenlandse entiteit', metVeld('ubo_bevestiging', 'Ja')))
    ).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.map((v) => v.code)).toContain('ubo_bevestiging')
  })
})

describe('leesKlantRijen — de intracommunautaire opgave', () => {
  it('neemt ze mee bij een btw-plichtig dossier', () => {
    const rij = leesKlantRijen(blad(metVeld('ic_opgave', 'Ja'))).rijen[0]
    expect(rij.fouten).toEqual([])
    expect(rij.verplichtingen.map((v) => v.code)).toContain('ic_opgave')
  })

  it('weigert ze bij een dossier zonder btw-regime', () => {
    // Zonder btw-nummer kun je geen vrijgestelde IC-leveringen doen.
    const rij = leesKlantRijen(
      blad(metVeld('btw_regime', 'Geen', metVeld('btw_aangifte_frequentie', '', metVeld('ic_opgave', 'Ja'))))
    ).rijen[0]
    expect(rij.fouten.join(' ')).toMatch(/zonder btw-regime/i)
  })
})
