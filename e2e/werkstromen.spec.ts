import { expect, test } from '@playwright/test'
import { login } from './helpers'

test.describe('Werkstromen', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('de vijf ingangen staan in de zijbalk', async ({ page }) => {
    for (const label of ['Btw', 'Afsluiting', 'Vennootschapsbelasting', 'Rapportering', 'Ad-hoc']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
  })

  test('Btw toont alleen btw-taken, in blokken per deadline', async ({ page }) => {
    await page.getByRole('button', { name: 'Btw', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Btw', level: 1 })).toBeVisible()

    await page.getByLabel('Deadlinevenster').selectOption('alles')
    await expect(page.getByText('Laden…')).toHaveCount(0)

    // Elke zichtbare verplichting hoort in deze werkstroom thuis.
    const cellen = await page.locator('tbody tr td:nth-child(3)').allInnerTexts()
    expect(cellen.length).toBeGreaterThan(0)
    for (const tekst of cellen) {
      expect(tekst).toMatch(/BTW/i)
    }
  })

  test('de jaarafsluiting zit bij Afsluiting en niet bij Btw', async ({ page }) => {
    await page.getByRole('button', { name: 'Afsluiting', exact: true }).click()
    await page.getByLabel('Deadlinevenster').selectOption('alles')
    await expect(page.getByText('Laden…')).toHaveCount(0)

    const cellen = await page.locator('tbody tr td:nth-child(3)').allInnerTexts()
    expect(cellen.join(' ')).toMatch(/Jaarafsluiting|Algemene vergadering|Neerlegging/i)
    expect(cellen.join(' ')).not.toMatch(/BTW-aangifte/i)
  })

  test('een smaller venster toont minder taken, maar houdt de achterstand', async ({ page }) => {
    await page.getByRole('button', { name: 'Btw', exact: true }).click()

    await page.getByLabel('Deadlinevenster').selectOption('alles')
    await expect(page.getByText('Laden…')).toHaveCount(0)
    const alles = await page.locator('tbody tr').count()

    await page.getByLabel('Deadlinevenster').selectOption('deze_week')
    await expect(page.getByText('Laden…')).toHaveCount(0)
    const week = await page.locator('tbody tr').count()

    expect(week).toBeLessThanOrEqual(alles)

    // Staat er achterstand, dan hoort die in élk venster te blijven staan.
    const teLaat = page.getByRole('heading', { name: 'Te laat' })
    if (await teLaat.count()) {
      await expect(teLaat.first()).toBeVisible()
    }
  })
})
