import { useEffect, useState, type ReactNode } from 'react'
import type { Employee } from '../types'
import { useAuth } from '../hooks/useAuth'
import { useSessiebediening } from '../hooks/useSessie'
import { klokTijd, SESSIE_UREN } from '../lib/sessieduur'
import { INGANGEN } from '../lib/werkstromen'
import { useKleinScherm } from '../hooks/useKleinScherm'
import { magOverzichtZien } from '../lib/overzicht'

interface NavItem {
  view: string
  param?: string
  label: string
  /** Wat je moet hebben om dit item te zien. Twee verschillende assen: het
   *  beheer van de app hangt aan de rol, het goedkeuren van aangiftes aan de
   *  graad (migratie 0042). Een partner die geen kantoorbeheerder is, hoort
   *  wél het goedkeuringsscherm te zien en niet de medewerkerslijst. */
  vereist?: 'kantoorbeheerder' | 'goedkeuringsrecht' | 'overzicht'
}

/** Ziet deze medewerker dit menu-item?
 *
 *  Drie assen, en ze liggen bewust niet op elkaar. Het beheer van de app hangt
 *  aan de rol; goedkeuren aan de graad vanaf manager (0042); meekijken aan de
 *  graad vanaf supervisor (0056). Die laatste grens ligt lager dan die van
 *  goedkeuren: de supervisor en de manager doen het meeste werk en hadden
 *  daarvóór géén overzichtsscherm -- dat stond op `kantoorbeheerder`. */
function magZien(item: NavItem, employee: Employee): boolean {
  if (item.vereist === 'kantoorbeheerder') return employee.rol === 'kantoorbeheerder'
  if (item.vereist === 'goedkeuringsrecht') return employee.mag_goedkeuren
  if (item.vereist === 'overzicht') return magOverzichtZien(employee)
  return true
}

interface NavGroep {
  /** Sleutel voor React; de kop is optioneel, de sleutel niet. */
  id: string
  /** Geen kop = geen groep. Een tussenkop boven één item ("Overzicht" met
   *  enkel Kalender eronder) leest als een categorie waar nog iets bij hoort. */
  titel?: string
  items: NavItem[]
}

/** De kalender staat als eerste en zonder kop: dat is het hoofdscherm, de
 *  plek waar je binnenkomt. Daaronder de werkstromen — daar begint het
 *  kantoor zijn dag ("ik wil enkel de BTW aangiftes zien"), en daar staat
 *  ook de achterstand, in het blok "Te laat" bovenaan elke stroom. */
function navGroepen(kleinScherm: boolean): NavGroep[] {
  return [
  {
    id: 'start',
    // Op een telefoon opent dit geen kalender maar een takenlijst (te laat,
    // vandaag, deze week). Het "Kalender" noemen zou beloven wat er niet staat.
    items: [
      { view: 'kalender', label: kleinScherm ? 'Taken' : 'Kalender' },
      { view: 'overzicht', label: 'Overzicht', vereist: 'overzicht' as const },
    ],
  },
  {
    id: 'werk',
    titel: 'Werk',
    items: [
      ...INGANGEN.map((ingang) => ({
        view: 'werk',
        param: ingang.pad,
        label: ingang.label,
      })),
      // Onderaan de werkstromen en niet erbovenaan: goedkeuren is wat je doet
      // nadat het werk gedaan is. Voor wie het recht niet heeft, bestaat dit
      // item niet -- een menu-item dat je aanklikt om te horen dat het niet
      // voor jou is, is erger dan geen menu-item.
      { view: 'goedkeuring', label: 'Goedkeuren', vereist: 'goedkeuringsrecht' as const },
    ],
  },
  {
    id: 'beheer',
    titel: 'Beheer',
    items: [
      { view: 'klanten', label: 'Klanten' },
      { view: 'workload', label: 'Workload', vereist: 'overzicht' },
      { view: 'wettelijke-kalender', label: 'Wettelijke kalender', vereist: 'kantoorbeheerder' },
      { view: 'medewerkers', label: 'Medewerkers', vereist: 'kantoorbeheerder' },
    ],
  },
  ]
}

/** De naam van het scherm waar je nu staat. Op een telefoon is de zijbalk
 *  dicht, en dan is dit het enige wat nog zegt waar je bent. */
function huidigeTitel(activeView: string, activeParam: string | undefined, kleinScherm: boolean): string {
  for (const groep of navGroepen(kleinScherm)) {
    for (const item of groep.items) {
      if (item.view === activeView && (item.param === undefined || item.param === activeParam)) {
        return item.label
      }
    }
  }
  // Een klantdossier: 'klanten' met een id erachter. Dat id is geen titel.
  return activeView === 'klanten' ? 'Klanten' : 'Taskflow'
}

export function AppLayout({
  employee,
  activeView,
  activeParam,
  navigate,
  children,
}: {
  employee: Employee
  activeView: string
  activeParam?: string
  navigate: (view: string, param?: string) => void
  children: ReactNode
}) {
  const { signOut } = useAuth()
  const { langeSessie, zetLangeSessie, eindeSessie } = useSessiebediening()
  // Op een telefoon staat de zijbalk in de weg: 240 van de 390 pixels zijn
  // dan navigatie. Daarom schuift ze daar open en dicht. Vanaf lg (1024px)
  // bestaat deze schakelaar niet: daar staat de balk gewoon vast, zoals ze
  // altijd stond.
  const kleinScherm = useKleinScherm()
  const groepen = navGroepen(kleinScherm)
  const [menuOpen, setMenuOpen] = useState(false)

  // Terug naar het werk zodra je iets gekozen hebt. Een menu dat open blijft
  // staan over het scherm dat je net opvroeg is op een telefoon hinderlijk.
  function ga(view: string, param?: string) {
    setMenuOpen(false)
    navigate(view, param)
  }

  // Escape sluit het menu. Wie het per ongeluk opent, moet er zonder te
  // mikken weer uit kunnen.
  useEffect(() => {
    if (!menuOpen) return
    function opToets(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', opToets)
    return () => window.removeEventListener('keydown', opToets)
  }, [menuOpen])

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* De bovenbalk bestaat alleen op een klein scherm. Ze houdt twee dingen
          vast die je anders kwijt bent zodra de zijbalk dichtgaat: waar je
          bent, en hoe je ergens anders komt. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="hoofdnavigatie"
          className="-ml-2 rounded-md p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <span className="sr-only">{menuOpen ? 'Menu sluiten' : 'Menu openen'}</span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-5 w-5" aria-hidden="true">
            {menuOpen ? (
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            ) : (
              <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <span className="truncate text-sm font-semibold text-slate-900">
          {huidigeTitel(activeView, activeParam, kleinScherm)}
        </span>
        <img
          src={`${import.meta.env.BASE_URL}rsm-logo.svg`}
          alt="RSM"
          className="ml-auto h-5 w-auto"
        />
      </header>

      {/* De achtergrond vangt de tik naast het menu op. Alleen zichtbaar
          wanneer het menu openstaat, en alleen op een klein scherm. */}
      {menuOpen && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
        />
      )}

      <aside
        id="hoofdnavigatie"
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:transition-none ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="border-b border-slate-200 px-4 py-4">
          {/* Klein gehouden: in de zijbalk is de navigatie het onderwerp, niet
              het merk. Het logo bevestigt alleen waar je zit. */}
          <img src={`${import.meta.env.BASE_URL}rsm-logo.svg`} alt="RSM" className="h-6 w-auto" />
          <span className="mt-2 block text-sm font-semibold text-slate-900">Taskflow</span>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          {groepen.map((groep) => {
            const items = groep.items.filter((item) => magZien(item, employee))
            if (items.length === 0) return null
            return (
              <div key={groep.id} className="space-y-0.5">
                {groep.titel && (
                  <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {groep.titel}
                  </p>
                )}
                {items.map((item) => {
                  const actief =
                    activeView === item.view &&
                    (item.param === undefined || activeParam === item.param)
                  return (
                    <button
                      key={`${item.view}/${item.param ?? ''}`}
                      type="button"
                      onClick={() => ga(item.view, item.param)}
                      className={`block w-full rounded-md px-3 py-2 text-left text-sm font-medium transition ${
                        actief
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      }`}
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <p className="truncate text-sm font-medium text-slate-800">{employee.naam}</p>
          <p className="truncate text-xs text-slate-400">
            {employee.rol === 'kantoorbeheerder' ? 'Kantoorbeheerder' : 'Medewerker'}
            {employee.mag_goedkeuren ? ' · mag goedkeuren' : ''}
          </p>
          {/* Normaal sluit het scherm zichzelf af na een half uur stilte.
              Wie een dag lang met hetzelfde dossier bezig is, wil daar niet
              telkens op klikken -- vandaar deze knop. De grens van twaalf uur
              blijft staan, en de keuze verdwijnt bij het afmelden: ze geldt
              voor deze aanmelding en niet langer. */}
          <button
            type="button"
            onClick={() => zetLangeSessie(!langeSessie)}
            aria-pressed={langeSessie}
            className={`mt-2 block text-xs font-medium focus:outline-none focus-visible:underline ${
              langeSessie ? 'text-amber-700 hover:text-amber-900' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {langeSessie
              ? `Blijft open${eindeSessie ? ` tot ${klokTijd(eindeSessie)}` : ''} — zet uit`
              : `Sessie ${SESSIE_UREN} uur openhouden`}
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-2 block text-xs font-medium text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:underline"
          >
            Uitloggen
          </button>
        </div>
      </aside>
      {/* pt-14 laat de vaste bovenbalk vrij; vanaf lg is er geen balk. */}
      <main className="min-w-0 flex-1 overflow-y-auto pt-14 lg:pt-0">{children}</main>
    </div>
  )
}
