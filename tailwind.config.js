/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // De accentkleur van Taskflow: een neutraal blauw, zonder huisstijl
        // van een kantoor. 500 is voor accenten, randen en focusringen (3:1
        // volstaat daar); 600 en 700 dragen alles met witte tekst erop, want
        // WCAG AA vraagt 4,5:1.
        brand: {
          50: '#eff6ff', // zachte vulling, o.a. de actieve menu-ingang
          100: '#dbeafe',
          300: '#93c5fd',
          500: '#3b82f6',
          600: '#2563eb', // wit erop: 5,17:1
          700: '#1d4ed8', // wit erop: 6,70:1; ook als tekst op brand-50
          800: '#1e40af',
          900: '#1e3a8a',
        },
      },
    },
  },
  plugins: [],
}
