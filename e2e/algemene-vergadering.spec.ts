import { expect, test } from '@playwright/test'
import { login, uniekeNaam } from './helpers'

/**
 * De scenariotest die de fout van 27/08/2026 zou hebben gevangen: een klant met
 * een boekjaareinde dat NIET op 31 december valt kreeg geen enkele taak voor de
 * algemene vergadering. De rekenregels klopten; wat ontbrak was een test die
 * een echte klant aanmaakt en kijkt wat eruit komt.
 *
 * Deze test SCHRIJFT in de echte database -- er is geen aparte testomgeving.
 * Daarom staat hij achter een vlag, en heet alles wat hij aanmaakt [E2E]:
 *
 *   TASKFLOW_E2E_WRITE=1 TASKFLOW_TEST_PASSWORD=... npx playwright test
 *
 * Opruimen achteraf: alle klanten met [E2E] in de naam mogen weg.
 */
const magSchrijven = process.env.TASKFLOW_E2E_WRITE === '1'

test.describe('Algemene vergadering', () => {
  test.skip(!magSchrijven, 'Zet TASKFLOW_E2E_WRITE=1 om in de echte database te schrijven.')

  test('een boekjaareinde op 30/06 krijgt wel degelijk AV-taken', async ({ page }) => {
    await login(page)

    const naam = uniekeNaam('Boekjaar juni BV')
    await page.getByRole('button', { name: 'Klanten', exact: true }).click()
    await page.getByRole('button', { name: 'Nieuwe klant' }).click()

    await page.getByLabel('Naam *').fill(naam)
    await page.getByLabel('Boekjaareinde — maand').selectOption('6')
    await page.getByLabel('Boekjaareinde — dag').fill('30')
    await page.getByLabel('BTW-regime').selectOption('geen')

    // Alles aanduiden wat het kantoor voor deze klant doet -- dat gebeurt in
    // één keer bij het aanmaken, niet achteraf via een aparte knop.
    await page.getByRole('checkbox', { name: 'Algemene vergadering' }).check()
    await page.getByRole('checkbox', { name: 'Jaarafsluiting' }).check()

    await page.getByRole('button', { name: 'Opslaan' }).click()
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 })

    // De taken horen er meteen te staan. Vroeger stond hier niets, en dat viel
    // alleen op als je toevallig naar die ene klant keek.
    await page.getByRole('button', { name: 'Afsluiting', exact: true }).click()
    await page.getByLabel('Deadlinevenster').selectOption('alles')
    await expect(page.getByText('Laden…')).toHaveCount(0)

    const rijen = page.locator('tbody tr', { hasText: naam })
    await expect(rijen.first()).toBeVisible({ timeout: 20_000 })

    const teksten = await rijen.allInnerTexts()
    const avRijen = teksten.filter((t) => /Algemene vergadering/i.test(t))
    expect(avRijen.length, 'geen enkele AV-taak voor een boekjaareinde op 30/06').toBeGreaterThan(0)

    // De AV valt binnen zes maanden na het boekjaareinde, dus in de tweede
    // jaarhelft -- nooit in juni, zoals bij een 31/12-klant.
    for (const rij of avRijen) {
      expect(rij).toMatch(/dec|jan/i)
    }
  })
})
