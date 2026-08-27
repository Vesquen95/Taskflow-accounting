import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// `base` moet voor GitHub Pages op '/<repo-naam>/' staan: een project-site
// wordt niet vanaf de domeinroot geserveerd. Lokaal (npm run dev) en bij
// hosts die wél vanaf de root serveren (Vercel/Netlify) moet dit '/' blijven.
// Daarom via de build-mode i.p.v. hardcoded: de deploy-workflow draait
// `vite build --mode gh-pages`, al de rest krijgt gewoon '/'.
export default defineConfig(({ mode }) => ({
  base: mode === 'gh-pages' ? '/Taskflow-accounting/' : '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ draait op Playwright tegen een echte browser en een echte site;
    // vitest zou die bestanden anders proberen te draaien en falen op de
    // Playwright-imports.
    exclude: ['node_modules', 'dist', 'e2e/**'],
    css: false,
  },
}))
