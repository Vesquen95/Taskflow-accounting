import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Tests mogen nooit afhangen van een lokale .env. `src/lib/supabase.ts` roept
// createClient() aan op module-load; zonder deze waarden gooit supabase-js
// "supabaseUrl is required" zodra een test (indirect) de client importeert —
// wat lokaal onzichtbaar blijft zolang er een .env op schijf staat, maar op
// een propere checkout (CI, of een verse clone) de suite laat crashen.
// setupFiles draaien vóór de imports van de testbestanden, dus de stub staat
// er op tijd. Dit zijn dummy-waarden: elke test die echt met Supabase praat
// mockt de client sowieso (zie src/test/supabaseMock.ts).
vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

// Ensure React Testing Library unmounts components between tests so state
// (and any Supabase mock call history) never leaks across test cases.
afterEach(() => {
  cleanup()
})
