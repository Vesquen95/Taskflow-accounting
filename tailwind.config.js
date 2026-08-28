/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // De huisstijl van het kantoor. RSM Blue is de merkkleur, maar wit
        // erop haalt maar 3,08:1 contrast en WCAG AA vraagt 4,5:1. Daarom is
        // 500 het echte merkblauw voor accenten, randen en focusringen (die
        // hebben 3:1 nodig, dat haalt het), en dragen 600 en 700 alles met
        // witte tekst erop.
        brand: {
          50: '#e8f6fd',  // zachte vulling, o.a. de actieve menu-ingang
          100: '#c7e9f9',
          500: '#009cde', // RSM Blue -- de merkkleur zelf
          600: '#0079ad', // wit erop: 4,84:1
          700: '#005c84', // wit erop: 7,33:1; ook als tekst op brand-50
          800: '#00153d', // RSM Midnight
        },
        // De overige merkkleuren, met hun eigen naam zodat ze niet per
        // ongeluk als statuskleur gebruikt worden: groen betekent in dit
        // systeem "afgewerkt", en dat is iets anders dan het merkgroen.
        rsm: {
          groen: '#3f9c35',
          grijs: '#888b8d',
          middernacht: '#00153d',
        },
      },
    },
  },
  plugins: [],
}
