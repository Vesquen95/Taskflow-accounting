import { vi } from 'vitest'

/**
 * Doet alsof het venster onder (of boven) de telefoongrens ligt.
 *
 * jsdom kent matchMedia niet. Zonder deze stub geeft useKleinScherm() dus
 * altijd `false` terug -- de computerversie -- en dat is precies wat de
 * bestaande tests nodig hebben. Wie de telefoonversie wil testen, zet hem
 * hiermee aan en krijgt een opruimfunctie terug.
 */
export function stelSchermIn(klein: boolean): () => void {
  const luisteraars = new Set<(e: MediaQueryListEvent) => void>()
  const origineel = window.matchMedia

  const mq = {
    matches: klein,
    media: '',
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => luisteraars.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => luisteraars.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue(mq),
  })

  return () => {
    if (origineel) {
      Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: origineel })
    } else {
      // @ts-expect-error -- terugbrengen naar "bestaat niet", zoals jsdom het levert.
      delete window.matchMedia
    }
  }
}
