import plugin from 'tailwindcss/plugin'
import standaard from 'tailwindcss/colors'

// ------------------------------------------------------------
// Het palet, overdag
// ------------------------------------------------------------

// Het palet: 60-30-10 (gevraagd 12/11/2026). 60% blush roze (243/195/200),
// 30% antraciet (42/42/47), 10% mint (34/227/162).
//
// Het neutraal draagt de eerste twee: de lichte kant is roze (de pagina,
// vullingen, lijnen), de donkere kant is antraciet (tekst, inkt). Getoetst
// tegen WCAG AA (4,5:1 voor tekst): 400 is de lichtste tekstkleur en haalt
// dat op wit (7,5:1) en op de roze pagina (4,8:1).
const slate = {
  50: '#F3C3C8', // de pagina: het roze, 60%
  100: '#F8DDE0',
  200: '#EBB9BF', // lijnen
  300: '#BE7F87', // randen van velden (3:1 op wit)
  400: '#57535C', // gedempte tekst, nog leesbaar
  500: '#4F4B54',
  600: '#45424A',
  700: '#38363D',
  800: '#303035',
  900: '#2A2A2F', // inkt: het antraciet, 30%
  950: '#1F1F23',
}

// De accentkleur: mint, 10%. Mint draagt geen witte tekst (1,7:1), dus een
// knop in mint krijgt antraciet tekst (`text-opaccent`, 8,6:1). 600 is de
// mint zelf; 500 is de hover, iets dieper (antraciet erop: 6,8:1); 700 en
// hoger zijn tekst op wit (700: 5,7:1).
const brand = {
  50: '#E6FCF4', // zachte vulling, o.a. de actieve menu-ingang
  100: '#C4F7E4',
  200: '#93F0CF',
  300: '#5FE8B9',
  400: '#3BE5AC',
  500: '#1CCB90', // hover van een knop, focusring
  600: '#22E3A2', // de mint: knoppen
  700: '#077552', // tekst en links op wit
  800: '#065C41',
  900: '#054532',
  950: '#032B1F',
}

// De kleurfamilies die de schermen gebruiken. Een nieuwe familie in een
// component? Voeg ze hier toe, anders schakelt ze niet mee in de nachtmodus.
const families = {
  slate,
  brand,
  red: standaard.red,
  orange: standaard.orange,
  amber: standaard.amber,
  emerald: standaard.emerald,
  blue: standaard.blue,
  purple: standaard.purple,
}

// ------------------------------------------------------------
// Het palet, 's nachts (<html data-modus="nacht">)
//
// Niet met de hand per kleur, maar uit dezelfde bron afgeleid: wat overdag
// een lichte vulling is (50-300), wordt 's nachts een donkere tint van de
// eigen kleur; wat overdag donkere tekst is (600-900), wordt lichte tekst.
// Zo leest een rood label 's nachts nog altijd rood, en blijft het contrast
// in dezelfde richting kloppen. Het neutraal en het accent zijn met de hand
// gezet: die dragen het hele scherm.
// ------------------------------------------------------------

const NACHT_ACHTERGROND = '#1C1C20'

const nachtSlate = {
  50: '#1C1C20', // de pagina
  100: '#26262B',
  200: '#34343A', // lijnen
  300: '#46454C',
  400: '#A99A9E', // gedempte tekst
  500: '#B9A8AC',
  600: '#CDBFC2',
  700: '#DDD1D3',
  800: '#ECE2E4',
  900: '#FBEFF0', // tekst: een zweem roze
  950: '#FFF7F8',
}
const nachtBrand = {
  50: '#12352A',
  100: '#164536',
  200: '#1C5C47',
  300: '#22785B',
  400: '#1CCB90',
  500: '#1FD497',
  600: '#22E3A2', // knoppen: de mint, met donkere tekst erop
  700: '#5FE8B9',
  800: '#93F0CF',
  900: '#C4F7E4',
  950: '#E6FCF4',
}
function rgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

function meng(hex, achtergrond, aandeel) {
  const a = rgb(hex)
  const b = rgb(achtergrond)
  const c = a.map((v, i) => Math.round(v * aandeel + b[i] * (1 - aandeel)))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** 's Nachts: de lichte kant wordt een donkere tint, de donkere kant licht. */
function nachtVan(familie) {
  return {
    50: meng(familie[900], NACHT_ACHTERGROND, 0.28),
    100: meng(familie[800], NACHT_ACHTERGROND, 0.38),
    200: meng(familie[700], NACHT_ACHTERGROND, 0.5),
    300: meng(familie[600], NACHT_ACHTERGROND, 0.65),
    400: familie[300],
    500: familie[400],
    600: familie[300],
    700: familie[200],
    800: familie[200],
    900: familie[100],
    950: familie[50],
  }
}

// `opaccent`: tekst op een vlak in de accentkleur. Mint is licht, dus dag
// en nacht antraciet.
const dag = { ...families, white: '#FFFFFF', opaccent: '#2A2A2F' }
const nacht = {
  ...Object.fromEntries(Object.entries(families).map(([naam, f]) => [naam, nachtVan(f)])),
  slate: nachtSlate,
  brand: nachtBrand,
  // "Wit" is overal de kleur van een blad: kaarten, vensters, invoervelden.
  // 's Nachts is dat blad donker. Witte tekst op een knop wordt zo donkere
  // tekst op een gloeiende knop -- precies wat het moet zijn.
  white: '#2A2A2F',
  opaccent: '#1C1C20',
}

/** "#0E6E64" -> "14 110 100", zodat Tailwinds /50-opaciteit blijft werken. */
const kanalen = (hex) => rgb(hex).join(' ')

function variabelen(palet) {
  const uit = {}
  for (const [naam, waarde] of Object.entries(palet)) {
    if (typeof waarde === 'string') uit[`--k-${naam}`] = kanalen(waarde)
    else for (const [tint, hex] of Object.entries(waarde)) uit[`--k-${naam}-${tint}`] = kanalen(hex)
  }
  return uit
}

function alsVariabelen(palet) {
  const uit = {}
  for (const [naam, waarde] of Object.entries(palet)) {
    if (typeof waarde === 'string') uit[naam] = `rgb(var(--k-${naam}) / <alpha-value>)`
    else uit[naam] = Object.fromEntries(Object.keys(waarde).map((t) => [t, `rgb(var(--k-${naam}-${t}) / <alpha-value>)`]))
  }
  return uit
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Atkinson Hyperlegible, ontworpen door het Braille Institute om
        // tekens die op elkaar lijken uit elkaar te houden: 0 en O, 1, l en I.
        // In een kantoor dat de hele dag ondernemingsnummers, periodes
        // (2026-Q3) en datums leest, is dat geen smaak maar een vereiste.
        // Zelf gehost (npm), niet van Google: geen IP-adressen naar derden.
        sans: ['"Atkinson Hyperlegible Next Variable"', 'system-ui', 'sans-serif'],
        // De uitlezingen en de opstartreeks: het inlogscherm en de cockpit.
        mono: ['"Atkinson Hyperlegible Mono Variable"', 'ui-monospace', 'monospace'],
      },
      fontWeight: {
        // Atkinson is van zichzelf stevig: op 500 leest gewone tekst al als
        // vet, en dan valt de nadruk die echt vet is weg. 450 houdt menu's
        // en tabellen rustig.
        medium: '450',
      },
      // Het inlogscherm (AuthPage): één opstartmoment, daarna rust. Alles
      // staat achter motion-safe:, dus wie minder beweging vraagt, krijgt
      // een stilstaand scherm.
      keyframes: {
        draai: { to: { transform: 'rotate(360deg)' } },
        knipper: { '50%': { opacity: '0' } },
        opstart: { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        // Het laadscherm: de petrol balk van het PATO-teken loopt heen en weer.
        laadbalk: { '0%, 100%': { transform: 'scaleX(0.2)' }, '50%': { transform: 'scaleX(1)' } },
        // De reactor (Reactor.tsx): de kern ademt; bij toegang een golf naar buiten.
        pulseer: { '0%, 100%': { opacity: '0.6' }, '50%': { opacity: '1' } },
        golf: { from: { transform: 'scale(0.7)', opacity: '1' }, to: { transform: 'scale(2.1)', opacity: '0' } },
        // De assistent "typt" zijn regels: de breedte groeit per teken (steps).
        typ: { from: { width: '0' } },
        // De opstart van de reactor: ringen komen draaiend op toeren, de kern
        // vonkt, een schokgolf, lijnen die zichzelf tekenen.
        ontsteek: {
          from: { opacity: '0', transform: 'scale(0.5) rotate(-240deg)' },
          to: { opacity: '1', transform: 'none' },
        },
        vonk: {
          '0%': { opacity: '0', transform: 'scale(0.1)' },
          '45%': { opacity: '1', transform: 'scale(1.35)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        schok: {
          '0%': { opacity: '0', transform: 'scale(0.4)' },
          '15%': { opacity: '1' },
          '100%': { opacity: '0', transform: 'scale(2.3)' },
        },
        verschijn: { from: { opacity: '0' } },
        teken: { from: { strokeDashoffset: '1' }, to: { strokeDashoffset: '0' } },
        balk: { from: { transform: 'scaleX(0)' } },
      },
      animation: {
        draai: 'draai 180s linear infinite',
        knipper: 'knipper 1s steps(1) infinite',
        opstart: 'opstart 0.4s ease-out both',
        laadbalk: 'laadbalk 1.4s ease-in-out infinite',
        pulseer: 'pulseer 3s ease-in-out infinite',
        golf: 'golf 1.2s ease-out infinite',
        typ: 'typ 1s steps(40) both',
        ontsteek: 'ontsteek 1.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        vonk: 'vonk 0.9s cubic-bezier(0.16, 1, 0.3, 1) both',
        schok: 'schok 1.1s ease-out both',
        verschijn: 'verschijn 0.35s ease-out both',
        teken: 'teken 0.8s ease-in-out both',
        balk: 'balk 0.45s ease-out both',
      },
      // Alle kleuren lopen via CSS-variabelen: één attribuut op <html> zet de
      // hele app in de nachtmodus, zonder dat een component het moet weten.
      colors: alsVariabelen(dag),
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': variabelen(dag),
        ':root[data-modus="nacht"]': { ...variabelen(nacht), colorScheme: 'dark' },
      })
    }),
  ],
}
