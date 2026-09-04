import basis from './playwright.config'

/**
 * Dezelfde tests, maar tegen een lokale build in plaats van de live site.
 * Nodig om een scherm te bekijken dat nog niet gedeployd is:
 *
 *   npm run build && npx vite preview --port 4173 --host 127.0.0.1
 *   npx playwright test -c playwright.lokaal.config.ts
 *
 * De `bypass` is geen detail: zonder haar stuurt Chromium ook het verkeer naar
 * 127.0.0.1 door de uitgaande proxy van de ontwikkelomgeving, die alleen
 * CONNECT-tunnels aanvaardt. Je krijgt dan geen proxyfout maar een lege pagina
 * met de tekst van de relay erin, en de test faalt op "wacht op E-mailadres" —
 * wat eruitziet alsof het inlogveld verdwenen is.
 */
export default {
  ...basis,
  use: {
    ...basis.use,
    baseURL: process.env.TASKFLOW_URL ?? 'http://127.0.0.1:4173/',
    proxy: process.env.HTTPS_PROXY
      ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' }
      : undefined,
  },
}
