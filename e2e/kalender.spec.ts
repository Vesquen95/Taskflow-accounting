import { expect, test } from '@playwright/test'
import { login } from './helpers'

/**
 * De kalender is sinds augustus 2026 het hoofdscherm. Deze tests kijken alleen
 * (geen schrijfvlag nodig) en bewaken twee dingen die makkelijk stil
 * terugkeren: waar je binnenkomt, en dat de drie verwijderde schermen niet
 * opnieuw in de zijbalk verschijnen.
 */
test.describe('Kalender als hoofdscherm', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('na het inloggen sta je op de kalender', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Kalender', level: 1 })).toBeVisible()
  })

  test('de werklijst, mijn taken en de escalatie-queue staan niet meer in de zijbalk', async ({
    page,
  }) => {
    for (const label of ['Werklijst', 'Mijn taken', 'Escalatie-queue']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    }
  })
})
