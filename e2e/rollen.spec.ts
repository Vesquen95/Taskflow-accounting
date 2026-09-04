import { expect, test, type Page } from '@playwright/test'
import { ACCOUNTS, login } from './helpers'

/**
 * Wat elke rol te zien krijgt — in een echte browser.
 *
 * Deze tests bestaan omdat vier schermen tot 04/09/2026 nog nooit geopend
 * waren buiten de unittests om: Workload, Wettelijke kalender en Medewerkers
 * (kantoorbeheerder) en Goedkeuren (goedkeuringsrecht). Het testaccount is
 * een junior medewerker en kwam er domweg niet bij. Een scherm dat niemand
 * ooit opent, kan maanden stuk staan zonder dat iemand het merkt.
 *
 * Alles hier LEEST alleen. Er wordt niets aangemaakt of gewijzigd.
 */

/** Consolefouten verzamelen: een scherm dat "werkt" maar in de console staat
 *  te gillen, is niet af. */
function letOpFouten(page: Page): string[] {
  const fouten: string[] = []
  page.on('pageerror', (e) => fouten.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') fouten.push(m.text())
  })
  return fouten
}

const BEHEERSCHERMEN = ['Workload', 'Wettelijke kalender', 'Medewerkers']

/**
 * Per beheerscherm iets dat er pas staat als de DATA binnen is.
 *
 * Op de titel controleren volstaat niet, en dat is hier geen theorie: de
 * eerste versie van deze test was groen terwijl het workload-dashboard nog
 * "Laden…" toonde. De kop staat er meteen; het bewijs dat het scherm werkt
 * staat eronder.
 */
const BEWIJS: Record<string, RegExp> = {
  Workload: /open taken/i,
  'Wettelijke kalender': /feestdagen/i,
  Medewerkers: /goedkeuren/i,
}

test.describe('de kantoorbeheerder', () => {
  test('opent alle drie de beheerschermen zonder fouten', async ({ page }) => {
    const fouten = letOpFouten(page)
    await login(page, ACCOUNTS.beheerder)

    for (const scherm of BEHEERSCHERMEN) {
      await page.getByRole('button', { name: scherm, exact: true }).click()
      // De titel bewijst dat de app niet terugviel op het hoofdscherm…
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        new RegExp(scherm.split(' ')[0], 'i')
      )
      // …en dit bewijst dat het scherm ook echt gevuld raakt.
      await expect(page.getByText(BEWIJS[scherm]).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('Laden…')).toHaveCount(0)
    }

    expect(fouten).toEqual([])
  })
})

test.describe('de twee assen staan los van elkaar', () => {
  test('een manager keurt goed maar beheert niet', async ({ page }) => {
    // Goedkeuren hangt aan de graad (migratie 0042), beheren aan de rol. Een
    // manager zonder beheerrol hoort het ene wel en het andere niet te zien.
    const fouten = letOpFouten(page)
    await login(page, ACCOUNTS.manager)

    const zijbalk = page.getByRole('complementary')
    await expect(zijbalk.getByRole('button', { name: 'Goedkeuren' })).toBeVisible()
    for (const scherm of BEHEERSCHERMEN) {
      await expect(zijbalk.getByRole('button', { name: scherm, exact: true })).toHaveCount(0)
    }

    await zijbalk.getByRole('button', { name: 'Goedkeuren' }).click()
    await expect(page.getByRole('heading', { name: 'Goedkeuren', level: 1 })).toBeVisible()
    await expect(page.getByText('Taken laden…')).toHaveCount(0)
    expect(fouten).toEqual([])
  })

  test('een junior ziet het goedkeuringsscherm niet, ook niet via de URL', async ({ page }) => {
    // Een menu-item verbergen is geen afscherming. Wie het adres intikt, hoort
    // op het hoofdscherm te belanden en niet op een lijst die hij niets kan
    // aandoen -- de databank weigert die stap sowieso (migratie 0011).
    await login(page, ACCOUNTS.medewerker)
    await expect(page.getByRole('complementary').getByRole('button', { name: 'Goedkeuren' })).toHaveCount(0)

    await page.goto('./#/goedkeuring')
    await expect(page.getByRole('heading', { name: 'Goedkeuren', level: 1 })).toHaveCount(0)
  })

  test('een medewerker komt niet op een beheerscherm via de URL', async ({ page }) => {
    await login(page, ACCOUNTS.medewerker)
    for (const pad of ['workload', 'wettelijke-kalender', 'medewerkers']) {
      await page.goto(`./#/${pad}`)
      await expect(page.getByRole('heading', { level: 1 })).not.toContainText(/workload|kalenderregel|medewerkers/i)
    }
  })
})

test.describe('de teammuur', () => {
  /** Het aantal dossiers dat de klantenlijst zegt te hebben. */
  async function aantalDossiers(page: Page): Promise<number> {
    await page.getByRole('complementary').getByRole('button', { name: 'Klanten' }).click()
    await expect(page.getByRole('heading', { name: /klanten/i, level: 1 })).toBeVisible()
    // Wachten tot de lijst geladen is: een telling op een half geladen scherm
    // bewijst niets.
    await expect(page.getByText(/laden/i)).toHaveCount(0)
    return page.getByRole('row').count()
  }

  test('een account uit Antwerpen ziet de dossiers van Aalst niet', async ({ page }) => {
    // Dit account heeft géén taak op zijn naam. Dat is met opzet: de
    // uitzondering "je ziet een dossier waar een taak van jou op staat" zou de
    // meting anders vertroebelen.
    await login(page, ACCOUNTS.antwerpen)
    const zichtbaar = await aantalDossiers(page)

    // Er staan honderd dossiers in de databank, verdeeld over zes teams. Wie er
    // maar één volgt, hoort er nooit honderd te zien.
    expect(zichtbaar).toBeGreaterThan(0)
    expect(zichtbaar).toBeLessThan(60)
  })

  test('een account zonder team ziet enkel dossiers zonder team', async ({ page }) => {
    await login(page, ACCOUNTS.zonderTeam)
    const zichtbaar = await aantalDossiers(page)
    expect(zichtbaar).toBeLessThan(20)
  })
})
