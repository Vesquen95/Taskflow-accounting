import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export const TEST_EMAIL = process.env.TASKFLOW_TEST_EMAIL ?? 'test@pato.be'
export const TEST_PASSWORD = process.env.TASKFLOW_TEST_PASSWORD ?? ''

/** Voorvoegsel voor alles wat een test aanmaakt, zodat het achteraf in de
 *  echte database terug te vinden en op te ruimen is. */
export const E2E = '[E2E]'

export async function login(page: Page) {
  if (!TEST_PASSWORD) {
    throw new Error(
      'Zet TASKFLOW_TEST_PASSWORD voor je de e2e-tests draait. Het wachtwoord ' +
        'staat bewust niet in de code.'
    )
  }
  await page.goto('./')
  await page.getByLabel('E-mailadres').fill(TEST_EMAIL)
  await page.getByLabel('Wachtwoord').fill(TEST_PASSWORD)
  // "Inloggen" staat twee keer op het scherm: als tab en als verzendknop.
  // Alleen die in het formulier logt echt in.
  await page.locator('form').getByRole('button', { name: 'Inloggen' }).click()
  // De zijbalk verschijnt pas als de medewerker geladen is.
  await expect(page.getByRole('button', { name: 'Werklijst' })).toBeVisible()
}

/** Een naam die uniek is per run, zodat parallelle of herhaalde runs elkaar
 *  niet in de weg zitten in één gedeelde database. */
export function uniekeNaam(basis: string) {
  return `${E2E} ${basis} ${Date.now().toString().slice(-6)}`
}
