import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthPage } from './AuthPage'

const signIn = vi.fn()
const signUp = vi.fn()

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ signIn, signUp, signOut: vi.fn(), session: null, user: null, loading: false }),
}))

beforeEach(() => {
  signIn.mockReset()
  signUp.mockReset()
  signIn.mockResolvedValue({ error: null })
  signUp.mockResolvedValue({ error: null })
})

/** The "Inloggen"/"Registreren" tab buttons share an accessible name with
 * the submit button in sign-in mode, so submit-related queries are scoped
 * to the <form> to stay unambiguous. */
function getForm() {
  return screen.getByLabelText('E-mailadres').closest('form')!
}

describe('AuthPage: sign in (default mode)', () => {
  it('requires email and password before the browser allows submission', () => {
    render(<AuthPage />)
    const form = getForm()
    const emailInput = screen.getByLabelText('E-mailadres') as HTMLInputElement
    const passwordInput = screen.getByLabelText('Wachtwoord') as HTMLInputElement
    expect(emailInput).toBeRequired()
    expect(passwordInput).toBeRequired()
    expect(form.checkValidity()).toBe(false)
  })

  it('enforces a minimum password length of 6 via the input constraint', () => {
    render(<AuthPage />)
    const passwordInput = screen.getByLabelText('Wachtwoord') as HTMLInputElement
    expect(passwordInput).toHaveAttribute('minLength', '6')
  })

  it('calls signIn with the entered credentials and shows no error on success', async () => {
    const user = userEvent.setup()
    render(<AuthPage />)

    await user.type(screen.getByLabelText('E-mailadres'), 'user@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'secret1')
    await user.click(within(getForm()).getByRole('button', { name: 'Inloggen' }))

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('user@example.com', 'secret1'))
    expect(signUp).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the returned error message when sign-in fails', async () => {
    const user = userEvent.setup()
    signIn.mockResolvedValue({ error: 'Ongeldige inloggegevens' })
    render(<AuthPage />)

    await user.type(screen.getByLabelText('E-mailadres'), 'user@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'wrongpass')
    await user.click(within(getForm()).getByRole('button', { name: 'Inloggen' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Ongeldige inloggegevens')
  })

  it('disables the submit button while the request is in flight', async () => {
    const user = userEvent.setup()
    let resolveSignIn: (v: { error: string | null }) => void = () => {}
    signIn.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve
      })
    )
    render(<AuthPage />)

    await user.type(screen.getByLabelText('E-mailadres'), 'user@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'secret1')
    await user.click(within(getForm()).getByRole('button', { name: 'Inloggen' }))

    const submitButton = within(getForm()).getByRole('button', { name: 'Bezig…' })
    expect(submitButton).toBeDisabled()
    resolveSignIn({ error: null })
    await waitFor(() => expect(within(getForm()).getByRole('button')).not.toBeDisabled())
  })
})

describe('AuthPage: sign up', () => {
  it('switches to sign-up mode and calls signUp instead of signIn', async () => {
    const user = userEvent.setup()
    render(<AuthPage />)

    await user.click(screen.getByRole('button', { name: 'Registreren' }))
    await user.type(screen.getByLabelText('E-mailadres'), 'new@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'secret1')
    await user.click(screen.getByRole('button', { name: 'Account aanmaken' }))

    await waitFor(() => expect(signUp).toHaveBeenCalledWith('new@example.com', 'secret1'))
    expect(signIn).not.toHaveBeenCalled()
  })

  it('shows a confirmation info message on successful sign-up', async () => {
    const user = userEvent.setup()
    render(<AuthPage />)

    await user.click(screen.getByRole('button', { name: 'Registreren' }))
    await user.type(screen.getByLabelText('E-mailadres'), 'new@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'secret1')
    await user.click(screen.getByRole('button', { name: 'Account aanmaken' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Account aangemaakt')
  })

  it('shows an error message and no info message when sign-up fails', async () => {
    const user = userEvent.setup()
    signUp.mockResolvedValue({ error: 'E-mailadres al in gebruik' })
    render(<AuthPage />)

    await user.click(screen.getByRole('button', { name: 'Registreren' }))
    await user.type(screen.getByLabelText('E-mailadres'), 'existing@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'secret1')
    await user.click(screen.getByRole('button', { name: 'Account aanmaken' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mailadres al in gebruik')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // KNOWN BUG (see test report): the "Inloggen"/"Registreren" tab buttons
  // only call setMode(...) — they never clear `error`/`info`. So a failed
  // sign-in's error message stays on screen (mislabeled, now sitting under
  // the sign-up form) after switching tabs, until the next submit. This
  // test encodes the intended behavior and will pass once the tab
  // handlers also reset error/info.
  it('clears a previous error/info message when switching modes', async () => {
    const user = userEvent.setup()
    signIn.mockResolvedValue({ error: 'Ongeldige inloggegevens' })
    render(<AuthPage />)

    await user.type(screen.getByLabelText('E-mailadres'), 'user@example.com')
    await user.type(screen.getByLabelText('Wachtwoord'), 'wrongpass')
    await user.click(within(getForm()).getByRole('button', { name: 'Inloggen' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Registreren' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
