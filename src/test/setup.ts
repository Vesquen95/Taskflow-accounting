import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Ensure React Testing Library unmounts components between tests so state
// (and any Supabase mock call history) never leaks across test cases.
afterEach(() => {
  cleanup()
})
