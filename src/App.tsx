import { AuthProvider, useAuth } from './hooks/useAuth'
import { CurrentEmployeeProvider, useCurrentEmployee } from './hooks/useCurrentEmployee'
import { useRoute } from './hooks/useRoute'
import { AuthPage } from './pages/AuthPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { AppLayout } from './components/AppLayout'
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

function AuthenticatedApp() {
  const { employee, loading } = useCurrentEmployee()
  const [route, navigate] = useRoute()

  if (loading) return <LoadingScreen />
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

  if (loading) return <LoadingScreen />
  if (!session) return <AuthPage />

  return (
    <CurrentEmployeeProvider>
      <AuthenticatedApp />
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
