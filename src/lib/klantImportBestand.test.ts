import { describe, expect, it } from 'vitest'
import { KOLOMMEN, KlantImportFout, MAX_BESTAND_BYTES } from './klantImport'
import { SJABLOON_BESTANDSNAAM, bouwSjabloonBlob, leesKlantenBestand } from './klantImportBestand'

const KOPPEN = KOLOMMEN.map((k) => k.kop)

/** Schrijft een echt .xlsx-bestand, zoals een gebruiker het zou aanleveren. */
async function maakXlsx(bladen: Array<{ sheet: string; data: unknown[][] }>): Promise<File> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const blob = await writeXlsxFile(
    bladen.map((b) => ({
      sheet: b.sheet,
      data: b.data.map((rij) =>
        rij.map((cel) => (cel === null || cel === undefined ? null : { value: String(cel), type: String as StringConstructor }))
      ),
    }))
  ).toBlob()
  return new File([blob], 'klanten.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

describe('het sjabloon', () => {
  it('is een echt .xlsx dat deze importer zelf zonder fouten inleest', async () => {
    const blob = await bouwSjabloonBlob()
    expect(blob.size).toBeGreaterThan(0)

    const voorbeeld = await leesKlantenBestand(new File([blob], SJABLOON_BESTANDSNAAM))
    expect(voorbeeld.rijen.length).toBeGreaterThanOrEqual(1)
    expect(voorbeeld.rijen.every((r) => r.fouten.length === 0)).toBe(true)
    expect(voorbeeld.aantalGeldig).toBe(voorbeeld.rijen.length)
  })

  it('levert uit zijn eigen voorbeeldrijen de instellingen op die het belooft', async () => {
    // Het sjabloon is tegelijk de uitleg. Een voorbeeldrij die wel inleest maar
    // iets anders betekent dan er staat, leert honderd rijen lang het verkeerde.
    const voorbeeld = await leesKlantenBestand(
      new File([await bouwSjabloonBlob()], SJABLOON_BESTANDSNAAM)
    )
    const eerste = voorbeeld.rijen[0].verplichtingen
    expect(eerste.find((v) => v.code === 'algemene_vergadering')?.parameters).toEqual({
      av_vorm: 'vaste_datum',
      av_maand: 5,
      av_dag: 15,
    })
    expect(eerste.find((v) => v.code === 'jaarafsluiting')?.parameters).toEqual({
      basis: 'voor_av',
      maanden_voor_av: 1,
    })

    const tweede = voorbeeld.rijen[1].verplichtingen
    expect(tweede.find((v) => v.code === 'algemene_vergadering')?.parameters).toMatchObject({
      av_vorm: 'nde_weekdag',
      av_rang: 'eerste',
      av_weekdag: 'maandag',
      av_maand: 12,
    })
    expect(tweede.find((v) => v.code === 'jaarafsluiting')?.parameters).toEqual({
      basis: 'boekjaar',
      sla_maanden: 3,
    })
  })

  it('heeft alle kolomkoppen van het sjabloon in het blad Klanten', async () => {
    const { default: readXlsxFile } = await import('read-excel-file/browser')
    const bladen = await readXlsxFile(await (await bouwSjabloonBlob()).arrayBuffer())
    const klanten = bladen.find((b) => b.sheet === 'Klanten')
    expect(klanten).toBeDefined()
    expect(klanten?.data[0]).toEqual(KOPPEN)
  })

  it('legt in een tweede blad uit welke waarden toegelaten zijn', async () => {
    const { default: readXlsxFile } = await import('read-excel-file/browser')
    const bladen = await readXlsxFile(await (await bouwSjabloonBlob()).arrayBuffer())
    const toelichting = bladen.find((b) => b.sheet === 'Toelichting')
    expect(toelichting).toBeDefined()
    const tekst = JSON.stringify(toelichting?.data)
    expect(tekst).toContain('Periodieke aangever')
    expect(tekst).toContain('Kwartaal')
  })
})

describe('leesKlantenBestand — een echt .xlsx', () => {
  it('leest een aangeleverd bestand en zegt per rij of het klopt', async () => {
    const file = await maakXlsx([
      {
        sheet: 'Klanten',
        data: [
          KOPPEN,
          ['Acme BV', 'Rechtspersoon', 'ZAV1', 'BE0123.456.749', 'BV', '12', '31', 'Periodieke aangever', 'Kwartaal', 'Ja'],
          // Een gat tussen de rijen, zoals mensen dat in Excel achterlaten.
          [],
          ['Beta NV', '', '', '', 'NV', '6', '30', 'Geen', '', 'Nee'],
          ['Gamma', '', '', '', '', '12', '31', 'onzin', '', 'Nee'],
        ],
      },
    ])

    const voorbeeld = await leesKlantenBestand(file)
    expect(voorbeeld.rijen).toHaveLength(3)
    expect(voorbeeld.aantalGeldig).toBe(2)
    expect(voorbeeld.rijen[2].excelRij).toBe(5)
    expect(voorbeeld.rijen[2].fouten.join(' ')).toMatch(/BTW-regime/i)
    expect(voorbeeld.legeRijenOvergeslagen).toBe(1)
  })

  it('kiest het blad Klanten, ook wanneer de uitleg vooraan staat', async () => {
    const file = await maakXlsx([
      { sheet: 'Toelichting', data: [['Vul het blad Klanten in.']] },
      { sheet: 'Klanten', data: [KOPPEN, ['Acme BV', '', '', '', '', '12', '31', 'Geen', '', 'Nee']] },
    ])
    const voorbeeld = await leesKlantenBestand(file)
    expect(voorbeeld.bladnaam).toBe('Klanten')
    expect(voorbeeld.aantalGeldig).toBe(1)
  })
})

describe('leesKlantenBestand — een bestand van buiten is niet te vertrouwen', () => {
  it('weigert een te groot bestand zonder het te parseren', async () => {
    const groot = new File([new Uint8Array(MAX_BESTAND_BYTES + 1)], 'groot.xlsx')
    await expect(leesKlantenBestand(groot)).rejects.toBeInstanceOf(KlantImportFout)
    await expect(leesKlantenBestand(groot)).rejects.toThrow(/MB/)
  })

  it('weigert een leeg bestand', async () => {
    await expect(leesKlantenBestand(new File([], 'leeg.xlsx'))).rejects.toBeInstanceOf(KlantImportFout)
  })

  it('weigert rommel die geen .xlsx is, met een uitlegbare melding', async () => {
    const rommel = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'foto.xlsx')
    await expect(leesKlantenBestand(rommel)).rejects.toBeInstanceOf(KlantImportFout)
    await expect(leesKlantenBestand(rommel)).rejects.toThrow(/Excel/i)
  })

  it('weigert een .csv die als Excel wordt aangeboden', async () => {
    const csv = new File(['naam;nummer\nAcme;BE0123.456.749\n'], 'klanten.csv', { type: 'text/csv' })
    await expect(leesKlantenBestand(csv)).rejects.toBeInstanceOf(KlantImportFout)
  })
})
