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
        // Alleen op het inlogscherm: de opstartreeks en de uitlezingen.
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
      },
      animation: {
        draai: 'draai 180s linear infinite',
        knipper: 'knipper 1s steps(1) infinite',
        opstart: 'opstart 0.4s ease-out both',
      },
      colors: {
        // Het neutraal van Taskflow: grijs met een zweem groen, de kleur van
        // gelinieerd kasboekpapier. Overschrijft Tailwinds slate, zodat elk
        // scherm in één keer meeschuift. Getoetst tegen WCAG AA (4,5:1 voor
        // tekst): 400 is de lichtste tekstkleur en haalt dat op wit (5,2:1)
        // én op de pagina (4,8:1).
        slate: {
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
        },
        // De accentkleur: petrol, het groen van de kasboeken en de ordners.
        // 500 voor randen en focusringen (3:1 volstaat daar); 600 en 700
        // dragen witte tekst (AA vraagt 4,5:1).
        brand: {
          50: '#EAF4F1', // zachte vulling, o.a. de actieve menu-ingang
          100: '#CFE8E1',
          300: '#7FC2B3',
          500: '#1E8F80', // 4,0:1 op wit
          600: '#0E6E64', // wit erop: 6,1:1
          700: '#0B574F', // wit erop: 8,4:1; ook als tekst op brand-50
          800: '#084540',
          900: '#063530',
        },
      },
    },
  },
  plugins: [],
}
