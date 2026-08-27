import type { Employee, ObligationType } from '../types'
import type { ObligationSelection } from '../lib/clientObligations'

/** btw_aangifte en btw_klantenlisting worden door de database zelf beheerd op
 *  basis van het btw-regime van de klant (trigger sync_btw_obligations, 0004).
 *  Ze staan hier alleen ter informatie: aan- of uitvinken zou toch overschreven
 *  worden bij het opslaan. */
const AFGELEID_UIT_BTW_REGIME = ['btw_aangifte', 'btw_klantenlisting']

const MAANDEN = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
]
const WEEKDAGEN = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']
const RANGEN = ['eerste', 'tweede', 'derde', 'vierde', 'laatste']

function veldKlasse() {
  return 'rounded-md border border-slate-300 px-2 py-1 text-sm'
}

export function ObligationPicker({
  obligationTypes,
  employees,
  selections,
  btwRegime,
  onChange,
}: {
  obligationTypes: ObligationType[]
  employees: Employee[]
  selections: ObligationSelection[]
  btwRegime: string
  onChange: (next: ObligationSelection[]) => void
}) {
  function wijzig(typeId: string, patch: Partial<ObligationSelection>) {
    onChange(
      selections.map((s) => (s.obligation_type_id === typeId ? { ...s, ...patch } : s))
    )
  }

  function wijzigParameter(typeId: string, sleutel: string, waarde: unknown) {
    const huidig = selections.find((s) => s.obligation_type_id === typeId)
    const parameters = { ...(huidig?.parameters ?? {}), [sleutel]: waarde }
    wijzig(typeId, { parameters })
  }

  return (
    <fieldset className="rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-xs font-medium text-slate-500">Verplichtingen</legend>
      <p className="mb-3 text-xs text-slate-500">
        Duid meteen alles aan wat je voor deze klant doet. Bij het opslaan staan de toekomstige taken klaar; wat je later
        afvinkt wordt geannuleerd, niet verwijderd.
      </p>

      <div className="space-y-2">
        {obligationTypes.map((type) => {
          const sel = selections.find((s) => s.obligation_type_id === type.id)
          if (!sel) return null
          const afgeleid = AFGELEID_UIT_BTW_REGIME.includes(type.code)
          const actiefViaBtw =
            (type.code === 'btw_aangifte' && btwRegime === 'periodieke_aangever') ||
            (type.code === 'btw_klantenlisting' && btwRegime !== 'geen')

          return (
            <div key={type.id} className="rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={afgeleid ? actiefViaBtw : sel.gekozen}
                  disabled={afgeleid}
                  onChange={(e) => wijzig(type.id, { gekozen: e.target.checked })}
                />
                <span className="font-medium text-slate-800">{type.naam}</span>
                {type.categorie === 'wettelijk' && (
                  <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    wettelijk
                  </span>
                )}
                {afgeleid && (
                  <span className="text-xs text-slate-400">volgt uit het btw-regime</span>
                )}
              </label>

              {!afgeleid && sel.gekozen && (
                <div className="mt-2 space-y-2 pl-6">
                  {type.code === 'algemene_vergadering' && (
                    <AvVelden
                      parameters={sel.parameters}
                      onParameter={(k, v) => wijzigParameter(type.id, k, v)}
                    />
                  )}

                  {type.code === 'jaarafsluiting' && (
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      Klaar binnen
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={(sel.parameters.sla_maanden as number) ?? 3}
                        onChange={(e) => wijzigParameter(type.id, 'sla_maanden', Number(e.target.value))}
                        className={`${veldKlasse()} w-16`}
                      />
                      maanden na het boekjaareinde
                    </label>
                  )}

                  {type.code === 'rapportering' && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <label className="flex items-center gap-2">
                        Frequentie
                        <select
                          value={(sel.parameters.frequentie as string) ?? 'kwartaal'}
                          onChange={(e) => wijzigParameter(type.id, 'frequentie', e.target.value)}
                          className={veldKlasse()}
                        >
                          <option value="maand">Maand</option>
                          <option value="kwartaal">Kwartaal</option>
                          <option value="jaar">Jaar</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        binnen
                        <input
                          type="number"
                          min={1}
                          max={90}
                          value={(sel.parameters.termijn_dagen as number) ?? 10}
                          onChange={(e) => wijzigParameter(type.id, 'termijn_dagen', Number(e.target.value))}
                          className={`${veldKlasse()} w-16`}
                        />
                        dagen na de periode
                      </label>
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    Standaard toegewezen aan
                    <select
                      value={sel.standaard_toegewezen_medewerker_id}
                      onChange={(e) => wijzig(type.id, { standaard_toegewezen_medewerker_id: e.target.value })}
                      className={veldKlasse()}
                    >
                      <option value="">De verantwoordelijke van de klant</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.naam}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

/** De statutaire AV-datum in de twee vormen die in statuten voorkomen
 *  (migratie 0020). De database weigert een datum die buiten de wettelijke
 *  zes maanden na het boekjaareinde valt. */
function AvVelden({
  parameters,
  onParameter,
}: {
  parameters: Record<string, unknown>
  onParameter: (sleutel: string, waarde: unknown) => void
}) {
  const vorm = (parameters.av_vorm as string) ?? 'vaste_datum'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
        <span>Statutaire datum</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="av_vorm"
            checked={vorm === 'vaste_datum'}
            onChange={() => onParameter('av_vorm', 'vaste_datum')}
          />
          Vaste datum
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="av_vorm"
            checked={vorm === 'nde_weekdag'}
            onChange={() => onParameter('av_vorm', 'nde_weekdag')}
          />
          N-de weekdag
        </label>
      </div>

      {vorm === 'vaste_datum' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <input
            type="number"
            min={1}
            max={31}
            aria-label="Dag van de maand"
            value={(parameters.av_dag as number) ?? 1}
            onChange={(e) => onParameter('av_dag', Number(e.target.value))}
            className={`${veldKlasse()} w-16`}
          />
          <select
            aria-label="Maand"
            value={(parameters.av_maand as number) ?? 6}
            onChange={(e) => onParameter('av_maand', Number(e.target.value))}
            className={veldKlasse()}
          >
            {MAANDEN.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <select
            aria-label="Rang"
            value={(parameters.av_rang as string) ?? 'eerste'}
            onChange={(e) => onParameter('av_rang', e.target.value)}
            className={veldKlasse()}
          >
            {RANGEN.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            aria-label="Weekdag"
            value={(parameters.av_weekdag as string) ?? 'maandag'}
            onChange={(e) => onParameter('av_weekdag', e.target.value)}
            className={veldKlasse()}
          >
            {WEEKDAGEN.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <span>van</span>
          <select
            aria-label="Maand"
            value={(parameters.av_maand as number) ?? 6}
            onChange={(e) => onParameter('av_maand', Number(e.target.value))}
            className={veldKlasse()}
          >
            {MAANDEN.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="text-[11px] text-slate-400">
        De vergadering moet binnen zes maanden na het boekjaareinde vallen; een datum daarbuiten wordt geweigerd.
      </p>
    </div>
  )
}
