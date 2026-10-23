import plugin from 'tailwindcss/plugin'
import standaard from 'tailwindcss/colors'

// ------------------------------------------------------------
// Het palet, overdag
// ------------------------------------------------------------

// Het neutraal van Taskflow: grijs met een zweem groen, de kleur van
// gelinieerd kasboekpapier. Overschrijft Tailwinds slate, zodat elk scherm in
// één keer meeschuift. Getoetst tegen WCAG AA (4,5:1 voor tekst): 400 is de
// lichtste tekstkleur en haalt dat op wit (5,2:1) én op de pagina (4,8:1).
const slate = {
  50: '#F3F6F4', // de pagina
  100: '#E7ECE9',
  200: '#D5DDD9', // lijnen
  300: '#BAC5C0',
  400: '#647069', // gedempte tekst, nog leesbaar
  500: '#58655F', // 6,1:1
  600: '#45514C',
  700: '#333E3A',
  800: '#252F2C',
  900: '#18211E', // inkt: 16,5:1
  950: '#0E1513',
}

// De accentkleur: petrol, het groen van de kasboeken en de ordners. 500 voor
// randen en focusringen (3:1 volstaat daar); 600 en 700 dragen witte tekst
// (AA vraagt 4,5:1).
const brand = {
  50: '#EAF4F1', // zachte vulling, o.a. de actieve menu-ingang
  100: '#CFE8E1',
  200: '#A9D8CC',
  300: '#7FC2B3',
  400: '#4FA898',
  500: '#1E8F80', // 4,0:1 op wit
  600: '#0E6E64', // wit erop: 6,1:1
  700: '#0B574F', // wit erop: 8,4:1; ook als tekst op brand-50
  800: '#084540',
  900: '#063530',
  950: '#04241F',
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

const NACHT_ACHTERGROND = '#070C0B'

const nachtSlate = {
  50: '#070C0B', // de pagina
  100: '#13221F',
  200: '#1A332F', // lijnen
  300: '#2A4943',
  400: '#86A098', // gedempte tekst
  500: '#9DB0AA',
  600: '#B3C3BE',
  700: '#CAD7D3',
  800: '#DDE8E4',
  900: '#EDF7F4', // tekst
  950: '#F7FCFA',
}

const nachtBrand = {
  50: '#0D2622',
  100: '#123630',
  200: '#1A4A42',
  300: '#23675C',
  400: '#2EB8A3',
  500: '#33D6BD',
  600: '#3EF0D2', // knoppen: gloeiend, met donkere tekst erop
  700: '#6FF5DE',
  800: '#9EF8E8',
  900: '#CCFBF2',
  950: '#E9FDF9',
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

const dag = { ...families, white: '#FFFFFF' }
const nacht = {
  ...Object.fromEntries(Object.entries(families).map(([naam, f]) => [naam, nachtVan(f)])),
  slate: nachtSlate,
  brand: nachtBrand,
  // "Wit" is overal de kleur van een blad: kaarten, vensters, invoervelden.
  // 's Nachts is dat blad donker. Witte tekst op een knop wordt zo donkere
  // tekst op een gloeiende knop -- precies wat het moet zijn.
  white: '#0B1513',
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
      },
      animation: {
        draai: 'draai 180s linear infinite',
        knipper: 'knipper 1s steps(1) infinite',
        opstart: 'opstart 0.4s ease-out both',
        laadbalk: 'laadbalk 1.4s ease-in-out infinite',
        pulseer: 'pulseer 3s ease-in-out infinite',
        golf: 'golf 1.2s ease-out infinite',
        typ: 'typ 1s steps(40) both',
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
