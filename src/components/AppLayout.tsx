import type { ReactNode } from 'react'
import type { Employee } from '../types'
import { useAuth } from '../hooks/useAuth'
import { INGANGEN } from '../lib/werkstromen'

interface NavItem {
  view: string
  param?: string
  label: string
  adminOnly?: boolean
}

interface NavGroep {
  titel: string
  items: NavItem[]
}

/** De werkstromen staan bovenaan en apart: dat is waar het kantoor zijn dag
 *  begint ("ik wil enkel de BTW aangiftes zien"). De brede lijsten eronder
 *  blijven bestaan voor wie het geheel wil overzien. */
const NAV_GROEPEN: NavGroep[] = [
  {
    titel: 'Werk',
    items: INGANGEN.map((ingang) => ({
      view: 'werk',
      param: ingang.pad,
      label: ingang.label,
    })),
  },
  {
    titel: 'Overzicht',
    items: [
      { view: 'werklijst', label: 'Werklijst' },
      { view: 'mijn-taken', label: 'Mijn taken' },
      { view: 'escalaties', label: 'Escalatie-queue' },
      { view: 'kalender', label: 'Kalender' },
    ],
  },
  {
    titel: 'Beheer',
    items: [
      { view: 'klanten', label: 'Klanten' },
      { view: 'workload', label: 'Workload', adminOnly: true },
      { view: 'wettelijke-kalender', label: 'Wettelijke kalender', adminOnly: true },
      { view: 'medewerkers', label: 'Medewerkers', adminOnly: true },
    ],
  },
]

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

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">T</div>
          <span className="text-base font-semibold text-slate-900">Taskflow</span>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          {NAV_GROEPEN.map((groep) => {
            const items = groep.items.filter(
              (item) => !item.adminOnly || employee.rol === 'kantoorbeheerder'
            )
            if (items.length === 0) return null
            return (
              <div key={groep.titel} className="space-y-0.5">
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {groep.titel}
                </p>
                {items.map((item) => {
                  const actief =
                    activeView === item.view &&
                    (item.param === undefined || activeParam === item.param)
                  return (
                    <button
                      key={`${item.view}/${item.param ?? ''}`}
                      type="button"
                      onClick={() => navigate(item.view, item.param)}
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
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-2 text-xs font-medium text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:underline"
          >
            Uitloggen
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}
