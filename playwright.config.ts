import { readFileSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Het testwachtwoord komt uit .env.e2e (niet in git). Zo staat het nooit in de
// code en ook niet in je shell-geschiedenis.
try {
  for (const regel of readFileSync('.env.e2e', 'utf8').split('\n')) {
    const m = regel.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch {
  // Geen .env.e2e: dan moeten de variabelen uit de omgeving komen.
}

/**
 * End-to-end tests tegen de LIVE site.
 *
 * Er is geen aparte testomgeving: deze tests loggen in op de echte Taskflow en
 * praten met de echte database. Dat betekent twee dingen, en beide staan hier
 * omdat ze makkelijk vergeten worden:
 *
 *   1. Alles wat een test aanmaakt blijft staan. Gebruik daarom het voorvoegsel
 *      [E2E] voor elke klant die je aanmaakt, zodat je het achteraf terugvindt.
 *   2. Raak geen bestaande dossiers aan. Lezen mag, wijzigen niet.
 *
 * Draaien:  TASKFLOW_TEST_PASSWORD=... npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Eén tegelijk: de tests delen één echte database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.TASKFLOW_URL ?? 'https://vesquen95.github.io/Taskflow-accounting/',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: '/opt/pw-browsers/chromium',
      // --ssl-version-max=tls1.2 is nodig binnen de Claude-sandbox: de
      // uitgaande proxy daar verbreekt Chromium's TLS 1.3-handshake (curl
      // werkt wel, de browser niet). Buiten die omgeving is de vlag
      // onschadelijk. Zonder deze regel faalt elke test op
      // net::ERR_CONNECTION_RESET, wat er ten onrechte uitziet als een
      // stukke site.
      args: ['--ssl-version-max=tls1.2'],
    },
    // Playwright start Chromium met --no-proxy-server tenzij je het expliciet
    // meegeeft; zonder deze regel komt de browser niet buiten de sandbox,
    // terwijl curl in dezelfde omgeving wel werkt.
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
