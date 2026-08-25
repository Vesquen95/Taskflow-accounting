import { useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { CurrentEmployeeProvider, useCurrentEmployee } from './hooks/useCurrentEmployee'
import { useRoute } from './hooks/useRoute'
import { AuthPage } from './pages/AuthPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { AppLayout } from './components/AppLayout'
import { AccountDeactivatedScreen } from './components/AccountDeactivatedScreen'
import { WerklijstPage } from './pages/WerklijstPage'
import { MijnTakenPage } from './pages/MijnTakenPage'
import { EscalatiePage } from './pages/EscalatiePage'
import { KalenderPage } from './pages/KalenderPage'
import { KlantenlijstPage } from './pages/KlantenlijstPage'
import { KlantDossierPage } from './pages/KlantDossierPage'
import { WorkloadDashboardPage } from './pages/WorkloadDashboardPage'
import { WettelijkeKalenderPage } from './pages/WettelijkeKalenderPage'
import { MedewerkersPage } from './pages/MedewerkersPage'

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <p className="text-sm text-slate-400">Laden…</p>
    </div>
  )
}

function AuthenticatedApp({ onDeactivated }: { onDeactivated: () => void }) {
  const { employee, loading } = useCurrentEmployee()
  const { signOut } = useAuth()
  const [route, navigate] = useRoute()

  // Security guard (not just a UI nicety): a kantoorbeheerder can
  // deactivate a colleague at any time, but that colleague's existing
  // Supabase session stays valid until it expires. RLS (0008) already
  // strips a deactivated employee's access at the database level, but we
  // also force a client-side sign-out the moment we notice `actief` is
  // false, rather than leaving them on a page that just silently fails to
  // load data.
  useEffect(() => {
    if (employee && employee.actief === false) {
      onDeactivated()
      void signOut()
    }
  }, [employee, onDeactivated, signOut])

  if (loading) return <LoadingScreen />
  if (employee && employee.actief === false) return <LoadingScreen />
  if (!employee) return <OnboardingPage />

  let page
  switch (route.view) {
    case 'mijn-taken':
      page = <MijnTakenPage />
      break
    case 'escalaties':
      page = <EscalatiePage />
      break
    case 'kalender':
      page = <KalenderPage />
      break
    case 'klanten':
      page = route.param ? <KlantDossierPage clientId={route.param} navigate={navigate} /> : <KlantenlijstPage navigate={navigate} />
      break
    case 'workload':
      page = employee.rol === 'kantoorbeheerder' ? <WorkloadDashboardPage /> : <WerklijstPage />
      break
    case 'wettelijke-kalender':
      page = employee.rol === 'kantoorbeheerder' ? <WettelijkeKalenderPage /> : <WerklijstPage />
      break
    case 'medewerkers':
      page = employee.rol === 'kantoorbeheerder' ? <MedewerkersPage /> : <WerklijstPage />
      break
    case 'werklijst':
    default:
      page = <WerklijstPage />
  }

  return (
    <AppLayout employee={employee} activeView={route.view} navigate={navigate}>
      {page}
    </AppLayout>
  )
}

function AppShell() {
  const { session, loading } = useAuth()
  // Lives above the session gate on purpose: once AuthenticatedApp forces
  // a sign-out on deactivation, `session` flips to null and would
  // otherwise unmount everything below (losing the reason why) before the
  // user ever sees it. This flag survives that because AppShell itself
  // stays mounted across the session transition.
  const [deactivated, setDeactivated] = useState(false)

  if (deactivated) {
    return <AccountDeactivatedScreen onAcknowledge={() => setDeactivated(false)} />
  }

  if (loading) return <LoadingScreen />
  if (!session) return <AuthPage />

  return (
    <CurrentEmployeeProvider>
      <AuthenticatedApp onDeactivated={() => setDeactivated(true)} />
    </CurrentEmployeeProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
