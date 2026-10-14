import type { UrgencyBand } from '../types'

/**
 * Een vervaldag als kalenderblaadje: de weekdag bovenaan, de dag groot
 * eronder. Het blaadje kleurt naar hoe dringend de dag is -- rood wat te laat
 * is, oranje wat deze week vervalt -- zodat je de lijst kunt overlopen zonder
 * één datum te lezen.
 */
const STROOK: Record<Exclude<UrgencyBand, null>, string> = {
  te_laat: 'bg-red-700 text-white',
  vandaag: 'bg-orange-600 text-white',
  deze_week: 'bg-orange-100 text-orange-800',
  binnenkort: 'bg-brand-50 text-brand-700',
  later: 'bg-slate-100 text-slate-600',
}

const RAND: Record<Exclude<UrgencyBand, null>, string> = {
  te_laat: 'border-red-700',
  vandaag: 'border-orange-600',
  deze_week: 'border-orange-300',
  binnenkort: 'border-brand-300',
  later: 'border-slate-200',
}

export function DagBlad({ datum, band }: { datum: string; band: Exclude<UrgencyBand, null> }) {
  const d = new Date(`${datum}T00:00:00`)
  return (
    <div aria-hidden="true" className={`w-12 shrink-0 self-start overflow-hidden rounded-md border bg-white text-center ${RAND[band]}`}>
      <div className={`py-0.5 text-[11px] font-semibold ${STROOK[band]}`}>
        {d.toLocaleDateString('nl-BE', { weekday: 'short' }).replace('.', '')}
      </div>
      <div className="py-1 text-xl font-bold leading-tight text-slate-900">{d.getDate()}</div>
    </div>
  )
}
