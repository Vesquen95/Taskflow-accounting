import { useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { CurrentEmployeeProvider, useCurrentEmployee } from './hooks/useCurrentEmployee'
import { useRoute } from './hooks/useRoute'
import { AuthPage } from './pages/AuthPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { AppLayout } from './components/AppLayout'
import { AccountDeactivatedScreen } from './components/AccountDeactivatedScreen'
import { SessieBewaker } from './components/SessieBewaker'
import { SessieProvider } from './hooks/useSessie'
import { WerkstroomPage } from './pages/WerkstroomPage'
import { ingangVoorPad } from './lib/werkstromen'
import { KalenderPage } from './pages/KalenderPage'
import { TelefoonPage } from './pages/TelefoonPage'
import { useKleinScherm } from './hooks/useKleinScherm'
import { KlantenlijstPage } from './pages/KlantenlijstPage'
import { KlantDossierPage } from './pages/KlantDossierPage'
import { WorkloadDashboardPage } from './pages/WorkloadDashboardPage'
import { OverzichtPage } from './pages/OverzichtPage'
import { GoedkeuringPage } from './pages/GoedkeuringPage'
import { WettelijkeKalenderPage } from './pages/WettelijkeKalenderPage'
import { MedewerkersPage } from './pages/MedewerkersPage'
import { magOverzichtZien } from './lib/overzicht'

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
  // Op een telefoon is het hoofdscherm een ander scherm, geen ingekrompen
  // kalender: de kalender toont de spreiding van deadlines over maanden, en
  // dat is precies wat op 390 pixels niet leesbaar is. Zie
  // src/pages/TelefoonPage.tsx.
  const kleinScherm = useKleinScherm()

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
  // Wat er op het scherm komt kan van de URL afwijken: een onbekende
  // werkstroom, een oude bookmark naar een verwijderd scherm, of een
  // beheerpagina waar deze medewerker geen recht op heeft. De zijbalk moet
  // markeren wat er écht staat, niet wat er gevraagd werd.
  let zichtbareView = route.view
  const naarHoofdscherm = () => {
    zichtbareView = 'kalender'
    return kleinScherm ? <TelefoonPage /> : <KalenderPage />
  }

  switch (route.view) {
    case 'werk': {
      // Onbekende werkstroom in de URL (oude bookmark, typefout): terug naar
      // het hoofdscherm in plaats van een leeg scherm.
      const ingang = route.param ? ingangVoorPad(route.param) : undefined
      page = ingang ? <WerkstroomPage ingang={ingang} /> : naarHoofdscherm()
      break
    }
    case 'klanten':
      page = route.param ? <KlantDossierPage clientId={route.param} navigate={navigate} /> : <KlantenlijstPage navigate={navigate} />
      break
    case 'goedkeuring':
      // Zonder goedkeuringsrecht is dit scherm leeg per definitie: de databank
      // laat die stap niet toe (migratie 0011). Terug naar het hoofdscherm in
      // plaats van een lijst die je niets kunt aandoen.
      page = employee.mag_goedkeuren ? <GoedkeuringPage /> : naarHoofdscherm()
      break
    case 'overzicht':
      // Vanaf supervisor (0056). De databank weigert het ook zelf; dit is de
      // beleefde variant -- een leeg scherm met een foutmelding is erger dan
      // teruggestuurd worden naar waar je wél iets kunt doen.
      page = magOverzichtZien(employee) ? <OverzichtPage navigate={navigate} /> : naarHoofdscherm()
      break
    case 'workload':
      page = magOverzichtZien(employee) ? <WorkloadDashboardPage /> : naarHoofdscherm()
      break
    case 'wettelijke-kalender':
      page = employee.rol === 'kantoorbeheerder' ? <WettelijkeKalenderPage /> : naarHoofdscherm()
      break
    case 'medewerkers':
      page = employee.rol === 'kantoorbeheerder' ? <MedewerkersPage /> : naarHoofdscherm()
      break
    // De kalender is het hoofdscherm en dus ook de terugval: een medewerker
    // die een beheerpagina opvraagt, een oude bookmark naar de verdwenen
    // werklijst/mijn taken/escalatie, of een lege hash komt hier uit.
    case 'kalender':
    default:
      page = naarHoofdscherm()
  }

  return (
    <AppLayout employee={employee} activeView={zichtbareView} activeParam={route.param} navigate={navigate}>
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
    <SessieProvider>
      {/* Buiten de rest van de app: de bewaking tikt per seconde zodra ze
          waarschuwt, en dat hoort het scherm eronder niet te merken. */}
      <SessieBewaker />
      <CurrentEmployeeProvider>
        <AuthenticatedApp onDeactivated={() => setDeactivated(true)} />
      </CurrentEmployeeProvider>
    </SessieProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
