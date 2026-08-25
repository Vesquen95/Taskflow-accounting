import type { ReactNode } from 'react'
import type { Employee } from '../types'
import { useAuth } from '../hooks/useAuth'

interface NavItem {
  view: string
  label: string
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { view: 'werklijst', label: 'Werklijst' },
  { view: 'mijn-taken', label: 'Mijn taken' },
  { view: 'escalaties', label: 'Escalatie-queue' },
  { view: 'kalender', label: 'Kalender' },
  { view: 'klanten', label: 'Klanten' },
  { view: 'workload', label: 'Workload', adminOnly: true },
  { view: 'wettelijke-kalender', label: 'Wettelijke kalender', adminOnly: true },
  { view: 'medewerkers', label: 'Medewerkers', adminOnly: true },
]

export function AppLayout({
  employee,
  activeView,
  navigate,
  children,
}: {
  employee: Employee
  activeView: string
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
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV_ITEMS.filter((item) => !item.adminOnly || employee.rol === 'kantoorbeheerder').map((item) => (
            <button
              key={item.view}
              type="button"
              onClick={() => navigate(item.view)}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm font-medium transition ${
                activeView === item.view
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
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
