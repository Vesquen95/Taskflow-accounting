/** Shown when the logged-in employee's `employees.actief` flag is false
 * (offboarded/deactivated by a kantoorbeheerder). The caller is expected to
 * have already forced a sign-out (see App.tsx) — this screen just makes the
 * reason clear instead of silently dropping the user back to the login
 * screen, and offers a way back to it once acknowledged. */
export function AccountDeactivatedScreen({ onAcknowledge }: { onAcknowledge: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Je account is gedeactiveerd</h1>
        <p className="mt-2 text-sm text-slate-600">
          Een kantoorbeheerder heeft je medewerkersaccount gedeactiveerd. Je bent automatisch uitgelogd en hebt geen
          toegang meer tot klant- of taakgegevens. Neem contact op met je kantoorbeheerder als je denkt dat dit een
          vergissing is.
        </p>
        <button
          type="button"
          onClick={onAcknowledge}
          className="mt-4 rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
        >
          Terug naar inloggen
        </button>
      </div>
    </div>
  )
}
