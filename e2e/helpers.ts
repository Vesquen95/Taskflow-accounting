import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

const TEST_EMAIL = process.env.TASKFLOW_TEST_EMAIL ?? 'test@pato.be'
const TEST_PASSWORD = process.env.TASKFLOW_TEST_PASSWORD ?? ''

/** Voorvoegsel voor alles wat een test aanmaakt, zodat het achteraf in de
 *  echte database terug te vinden en op te ruimen is. */
const E2E = '[E2E]'

/**
 * De testaccounts, met wat elk van hen mag. Ze delen één wachtwoord
 * (TASKFLOW_TEST_PASSWORD): dat is bewust, zo is er geen tweede geheim om
 * kwijt te raken, en het zijn alle vijf accounts op de testomgeving.
 *
 * Ze bestaan omdat vier schermen anders onbereikbaar blijven voor deze tests:
 * Workload, Wettelijke kalender en Medewerkers vragen de rol kantoorbeheerder,
 * Goedkeuren vraagt goedkeuringsrecht. En de teammuur (migratie 0039) valt
 * alleen van BUITEN te beproeven: met een account dat er niet bij hoort.
 */
export const ACCOUNTS = {
  /** Medewerker, junior, team AAL. Heeft taken op zijn naam staan. */
  medewerker: TEST_EMAIL,
  /** Kantoorbeheerder, partner, team ZAV1. Voor de drie beheerschermen. */
  beheerder: 'e2e-beheer@pato.be',
  /** Medewerker met goedkeuringsrecht, manager, team ZAV1. Bewijst dat de twee
   *  assen los staan: goedkeuren zonder beheerrechten. */
  manager: 'e2e-manager@pato.be',
  /** Medewerker, senior, team ANT, zonder één taak op zijn naam. Zo meet je
   *  de teamregel zuiver, los van de uitzondering voor toegewezen taken. */
  antwerpen: 'e2e-ant@pato.be',
  /** Medewerker zonder team. Ziet enkel dossiers die zelf geen team hebben. */
  zonderTeam: 'e2e-geenteam@pato.be',
} as const

export async function login(page: Page, email: string = TEST_EMAIL) {
  if (!TEST_PASSWORD) {
    throw new Error(
      'Zet TASKFLOW_TEST_PASSWORD voor je de e2e-tests draait. Het wachtwoord ' +
        'staat bewust niet in de code.'
    )
  }
  await page.goto('./')
  await page.getByLabel('E-mailadres').fill(email)
  await page.getByLabel('Wachtwoord').fill(TEST_PASSWORD)
  // "Inloggen" staat twee keer op het scherm: als tab en als verzendknop.
  // Alleen die in het formulier logt echt in.
  await page.locator('form').getByRole('button', { name: 'Inloggen' }).click()
  // De zijbalk verschijnt pas als de medewerker geladen is. "Uitloggen"
  // staat onderaan die zijbalk en hoort bij het ingelogd zijn zelf, niet bij
  // één scherm: schermen komen en gaan (de Werklijst waar deze controle
  // vroeger op wachtte, bestaat niet meer), deze knop blijft.
  await expect(page.getByRole('button', { name: 'Uitloggen' })).toBeVisible()
}

/** Een naam die uniek is per run, zodat parallelle of herhaalde runs elkaar
 *  niet in de weg zitten in één gedeelde database. */
export function uniekeNaam(basis: string) {
  return `${E2E} ${basis} ${Date.now().toString().slice(-6)}`
}
