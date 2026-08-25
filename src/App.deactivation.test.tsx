import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage for the actief=false ("deactivated employee") flow
// wired up in App.tsx (AppShell / AuthenticatedApp / AccountDeactivatedScreen).
// Mocks useAuth and useCurrentEmployee directly rather than the Supabase
// client, since App.tsx only talks to those two hooks.

const signOut = vi.fn().mockResolvedValue(undefined)
let mockSession: unknown = { user: { id: 'u1' } }
let mockEmployee: unknown = null
let mockEmployeeLoading = false

vi.mock('./hooks/useAuth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    session: mockSession,
    user: mockSession ? { id: 'u1' } : null,
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut,
  }),
}))

vi.mock('./hooks/useCurrentEmployee', () => ({
  CurrentEmployeeProvider: ({ children }: { children: React.ReactNode }) => children,
  useCurrentEmployee: () => ({
    employee: mockEmployee,
    loading: mockEmployeeLoading,
    error: null,
    reload: vi.fn(),
  }),
}))

// Avoid rendering the full authenticated page tree (many pages talk to
// Supabase directly); AuthenticatedApp only needs to reach the
// employee.actief === false branch for this test.
vi.mock('./components/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="app-layout">{children}</div>,
}))
vi.mock('./pages/WerklijstPage', () => ({ WerklijstPage: () => <div>werklijst</div> }))

import App from './App'

beforeEach(() => {
  signOut.mockClear()
  mockSession = { user: { id: 'u1' } }
  mockEmployee = { id: 'e1', naam: 'Jan', rol: 'medewerker', actief: true }
  mockEmployeeLoading = false
})

describe('App — employee deactivation flow (actief: true -> false)', () => {
  it('shows AccountDeactivatedScreen and force-signs-out when the current employee is actief=false', async () => {
    mockEmployee = { id: 'e1', naam: 'Jan', rol: 'medewerker', actief: false }
    render(<App />)

    expect(await screen.findByText('Je account is gedeactiveerd')).toBeInTheDocument()
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    // Must not render the authenticated shell behind the deactivation screen.
    expect(screen.queryByTestId('app-layout')).not.toBeInTheDocument()
  })

  it('does not show the deactivated screen for an active employee', async () => {
    render(<App />)
    expect(await screen.findByTestId('app-layout')).toBeInTheDocument()
    expect(screen.queryByText('Je account is gedeactiveerd')).not.toBeInTheDocument()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('acknowledging the deactivation screen returns to the sign-in page once the session is cleared', async () => {
    mockEmployee = { id: 'e1', naam: 'Jan', rol: 'medewerker', actief: false }
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('Je account is gedeactiveerd')
    // Simulate the signOut() call actually having cleared the session by
    // the time the user acknowledges (this is what onAuthStateChange would
    // do in the real AuthProvider).
    mockSession = null

    await user.click(screen.getByRole('button', { name: 'Terug naar inloggen' }))

    expect(await screen.findByRole('heading', { name: 'Taskflow' })).toBeInTheDocument()
    expect(screen.queryByText('Je account is gedeactiveerd')).not.toBeInTheDocument()
  })
})
