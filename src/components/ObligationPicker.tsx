import { useEffect, useState } from 'react'
import type { Employee, ObligationType } from '../types'
import type { ObligationSelection } from '../lib/clientObligations'
import {
  AV_GEEN_STATUTAIRE_DATUM,
  avParametersVoorVorm,
  JAARAFSLUITING_BASIS_BOEKJAAR,
  JAARAFSLUITING_BASIS_VOOR_AV,
  jaarafsluitingBasis,
  jaarafsluitingParametersVoorBasis,
  metParameter,
  metStandaardParameters,
  metStandaardParametersVoorSelecties,
  STANDAARD_PARAMETERS,
  type ObligationParameters,
} from '../lib/obligationParameters'

/** btw_aangifte en btw_klantenlisting worden door de database zelf beheerd op
 *  basis van het btw-regime van de klant (trigger sync_btw_obligations, 0004).
 *  Ze staan hier alleen ter informatie: aan- of uitvinken zou toch overschreven
 *  worden bij het opslaan. */
const AFGELEID_UIT_BTW_REGIME = ['btw_aangifte', 'btw_klantenlisting']

/** Verplichtingen die niet samen kunnen (migratie 0035). Het scherm mag niet
 *  aanbieden wat de databank daarna weigert -- en belangrijker: wie hier een
 *  vinkje zet dat straks sneuvelt, denkt intussen dat het geregeld is.
 *
 *  De rechtsvorm speelt geen rol. Een VZW kan evengoed onderworpen zijn aan de
 *  vennootschapsbelasting; wat telt is wat je hier aanduidt. */
const BOTST_MET: Record<string, string[]> = {
  aangifte_venb_pb: ['aangifte_rpb'],
  aangifte_rpb: ['aangifte_venb_pb', 'va_venb'],
  va_venb: ['aangifte_rpb'],
}

/** Wat er niet langer aangeboden wordt zolang iets anders aanstaat.
 *
 *  Bewust maar één richting, en niet elk botsend paar. De twee aangiftes
 *  moeten elkaar met één klik kunnen vervangen: blokkeer je ze allebei, dan
 *  moet je eerst afvinken voor je kunt omschakelen -- en met de
 *  voorafbetalingen er nog bij zijn dat drie handelingen voor één beslissing,
 *  waarbij de melding telkens maar één van de blokkades noemt.
 *
 *  De voorafbetalingen zijn geen keuze naast de RPB maar een gevolg van de
 *  vennootschapsbelasting. Die verdwijnen dus wél. */
const NIET_BESCHIKBAAR_BIJ: Record<string, string> = {
  va_venb: 'aangifte_rpb',
}

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
  // Een verplichting die al aangevinkt uit de database komt (een bestaande
  // klant bewerken) kan parameters missen die het scherm wél toont. Zet ze er
  // dan alsnog echt in, zodat weergave en opslag hetzelfde zeggen. Bestaande
  // waarden blijven ongemoeid; is er niets aan te vullen, dan geeft de helper
  // dezelfde array terug en gebeurt er niets.
  useEffect(() => {
    const genormaliseerd = metStandaardParametersVoorSelecties(obligationTypes, selections)
    if (genormaliseerd !== selections) onChange(genormaliseerd)
  }, [obligationTypes, selections, onChange])

  function wijzig(typeId: string, patch: Partial<ObligationSelection>) {
    onChange(
      selections.map((s) => (s.obligation_type_id === typeId ? { ...s, ...patch } : s))
    )
  }

  function zetParameters(typeId: string, parameters: ObligationParameters) {
    wijzig(typeId, { parameters })
  }

  function wijzigParameter(typeId: string, sleutel: string, waarde: unknown) {
    const huidig = selections.find((s) => s.obligation_type_id === typeId)
    zetParameters(typeId, metParameter(huidig?.parameters ?? {}, sleutel, waarde))
  }

  /** Aanvinken schrijft de standaardwaarden die het scherm toont meteen in
   *  parameters; afvinken laat ze staan, zodat opnieuw aanvinken niet stil
   *  iets anders bewaart dan wat er stond. */
  function wijzigGekozen(type: ObligationType, gekozen: boolean) {
    const huidig = selections.find((s) => s.obligation_type_id === type.id)
    if (!gekozen) {
      wijzig(type.id, { gekozen: false })
      return
    }
    // Wat hiermee botst gaat meteen uit, zichtbaar: je ziet het vinkje
    // wegvallen en de reden eronder verschijnen. Dat is eerlijker dan het
    // laten staan tot de databank het bij het opslaan afwijst.
    const botsend = BOTST_MET[type.code] ?? []
    const botsendeIds = new Set(
      obligationTypes.filter((t) => botsend.includes(t.code)).map((t) => t.id)
    )
    onChange(
      selections.map((sel) => {
        if (sel.obligation_type_id === type.id) {
          return { ...sel, gekozen: true, parameters: metStandaardParameters(type.code, huidig?.parameters ?? {}) }
        }
        if (botsendeIds.has(sel.obligation_type_id) && sel.gekozen) {
          return { ...sel, gekozen: false }
        }
        return sel
      })
    )
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

          // Staat datgene aan waardoor deze verplichting niet meer van
          // toepassing is? Dan is het vakje niet beschikbaar, met de reden
          // erbij. Is deze zelf aangevinkt -- dat kan alleen bij oudere
          // gegevens -- dan blokkeren we niets: dan moet je het juist kunnen
          // rechtzetten.
          const blokkeerder = NIET_BESCHIKBAAR_BIJ[type.code]
          const botstMet =
            !sel.gekozen && blokkeerder
              ? obligationTypes.find(
                  (ander) =>
                    ander.code === blokkeerder &&
                    selections.some((s) => s.obligation_type_id === ander.id && s.gekozen)
                )
              : undefined

          return (
            <div key={type.id} className="rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={afgeleid ? actiefViaBtw : sel.gekozen}
                  disabled={afgeleid || botstMet !== undefined}
                  onChange={(e) => wijzigGekozen(type, e.target.checked)}
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
                {botstMet && (
                  <span className="text-xs text-slate-400">gaat niet samen met {botstMet.naam}</span>
                )}
              </label>

              {!afgeleid && sel.gekozen && (
                <div className="mt-2 space-y-2 pl-6">
                  {type.code === 'algemene_vergadering' && (
                    <AvVelden
                      parameters={sel.parameters}
                      onVorm={(vorm) => zetParameters(type.id, avParametersVoorVorm(sel.parameters, vorm))}
                      onParameter={(k, v) => wijzigParameter(type.id, k, v)}
                    />
                  )}

                  {type.code === 'jaarafsluiting' && (
                    <JaarafsluitingVelden
                      parameters={sel.parameters}
                      onBasis={(basis) =>
                        zetParameters(type.id, jaarafsluitingParametersVoorBasis(sel.parameters, basis))
                      }
                      onParameter={(k, v) => wijzigParameter(type.id, k, v)}
                    />
                  )}

                  {type.code === 'rapportering' && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <label className="flex items-center gap-2">
                        Frequentie
                        <select
                          aria-label="Frequentie"
                          value={(sel.parameters.frequentie as string) ?? ''}
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
                        <GetalVeld
                          label="Termijn (dagen na periode)"
                          min={1}
                          max={90}
                          waarde={getal(
                            sel.parameters.termijn_dagen,
                            STANDAARD_PARAMETERS.rapportering.termijn_dagen as number
                          )}
                          onWijzig={(n) => wijzigParameter(type.id, 'termijn_dagen', n)}
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

/**
 * De jaarafsluiting rekent op twee manieren (migratie 0029). De keuze staat
 * vooraan, want ze bepaalt welk getal eronder betekenis heeft; een scherm dat
 * allebei de getallen tegelijk toont laat de gebruiker een waarde invullen die
 * niets doet.
 *
 * "Voor de algemene vergadering" is de reden dat dit bestaat: de boeken
 * worden op die vergadering goedgekeurd, dus ze moeten daarvoor klaar zijn.
 */
function JaarafsluitingVelden({
  parameters,
  onBasis,
  onParameter,
}: {
  parameters: ObligationParameters
  onBasis: (basis: string) => void
  onParameter: (sleutel: string, waarde: unknown) => void
}) {
  const basis = jaarafsluitingBasis(parameters)

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <label className="flex items-center gap-2">
        Deadline
        <select
          aria-label="Deadline jaarafsluiting"
          value={basis}
          onChange={(e) => onBasis(e.target.value)}
          className={veldKlasse()}
        >
          <option value={JAARAFSLUITING_BASIS_BOEKJAAR}>maanden na het boekjaareinde</option>
          <option value={JAARAFSLUITING_BASIS_VOOR_AV}>maanden voor de algemene vergadering</option>
        </select>
      </label>

      {basis === JAARAFSLUITING_BASIS_VOOR_AV ? (
        <label className="flex items-center gap-2">
          <GetalVeld
            label="Maanden voor de algemene vergadering"
            min={1}
            max={6}
            waarde={getal(parameters.maanden_voor_av, 1)}
            onWijzig={(n) => onParameter('maanden_voor_av', n)}
          />
          maanden voor de algemene vergadering
        </label>
      ) : (
        <label className="flex items-center gap-2">
          Klaar binnen
          <GetalVeld
            label="Klaar binnen (maanden na boekjaareinde)"
            min={1}
            max={12}
            waarde={getal(parameters.sla_maanden, 3)}
            onWijzig={(n) => onParameter('sla_maanden', n)}
          />
          maanden na het boekjaareinde
        </label>
      )}

      {basis === JAARAFSLUITING_BASIS_VOOR_AV && (
        // Zonder statutaire AV-datum rekent de motor met de wettelijke uiterste
        // datum (boekjaareinde + 6 maanden). Dat is een echte datum, maar zelden
        // de dag waarop de vergadering werkelijk plaatsvindt -- en dan schuift
        // de afsluiting mee.
        <p className="w-full text-[11px] text-slate-500">
          Is er bij de algemene vergadering geen statutaire datum ingevuld, dan
          rekent Taskflow met de wettelijke uiterste datum: zes maanden na het
          boekjaareinde.
        </p>
      )}
    </div>
  )
}

/** Een getalveld toont wat er opgeslagen staat. De standaardwaarde wordt bij
 *  het aanvinken al weggeschreven, dus dit is alleen een vangnet voor de
 *  fractie van een seconde tussen aanvinken en die schrijfactie. */
function getal(waarde: unknown, standaard: number): number {
  return typeof waarde === 'number' ? waarde : standaard
}

/** Een getalveld dat altijd toont wat er opgeslagen staat, maar tijdens het
 *  typen even leeg mag zijn (wie een 3 wil vervangen door een 6 wist eerst).
 *  Zodra er een getal staat wordt dat meteen bewaard; blijft het veld leeg,
 *  dan verandert er niets en verschijnt bij het verlaten opnieuw de bewaarde
 *  waarde. Zo staat er nooit een getal op het scherm dat niet opgeslagen is. */
function GetalVeld({
  label,
  waarde,
  min,
  max,
  onWijzig,
}: {
  label: string
  waarde: number
  min: number
  max: number
  onWijzig: (waarde: number) => void
}) {
  const [ruw, setRuw] = useState<string | null>(null)

  return (
    <input
      type="number"
      min={min}
      max={max}
      aria-label={label}
      value={ruw ?? String(waarde)}
      onChange={(e) => {
        const tekst = e.target.value
        const n = Number(tekst)
        if (tekst.trim() === '' || Number.isNaN(n)) {
          setRuw(tekst)
          return
        }
        setRuw(null)
        onWijzig(n)
      }}
      onBlur={() => setRuw(null)}
      className={`${veldKlasse()} w-16`}
    />
  )
}

/** De statutaire AV-datum in de twee vormen die in statuten voorkomen
 *  (migratie 0020). De database weigert een datum die buiten de wettelijke
 *  zes maanden na het boekjaareinde valt.
 *
 *  Hier staat bewust géén ingevulde standaard: de statutaire datum komt uit de
 *  statuten van dit ene dossier. De keuzelijsten beginnen leeg ("Kies…") en
 *  tonen dus exact wat er opgeslagen wordt. */
function AvVelden({
  parameters,
  onVorm,
  onParameter,
}: {
  parameters: ObligationParameters
  onVorm: (vorm: string) => void
  onParameter: (sleutel: string, waarde: unknown) => void
}) {
  const vorm = typeof parameters.av_vorm === 'string' ? parameters.av_vorm : AV_GEEN_STATUTAIRE_DATUM

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
        <span>Statutaire datum</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="av_vorm"
            checked={vorm === AV_GEEN_STATUTAIRE_DATUM}
            onChange={() => onVorm(AV_GEEN_STATUTAIRE_DATUM)}
          />
          Niet in de statuten
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="av_vorm"
            checked={vorm === 'vaste_datum'}
            onChange={() => onVorm('vaste_datum')}
          />
          Vaste datum
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="av_vorm"
            checked={vorm === 'nde_weekdag'}
            onChange={() => onVorm('nde_weekdag')}
          />
          N-de weekdag
        </label>
      </div>

      {vorm === 'vaste_datum' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <input
            type="number"
            min={1}
            max={31}
            aria-label="Dag van de maand"
            placeholder="dag"
            value={typeof parameters.av_dag === 'number' ? parameters.av_dag : ''}
            onChange={(e) => onParameter('av_dag', e.target.value === '' ? undefined : Number(e.target.value))}
            className={`${veldKlasse()} w-16`}
          />
          <MaandKeuze waarde={parameters.av_maand} onKies={(v) => onParameter('av_maand', v)} />
        </div>
      )}

      {vorm === 'nde_weekdag' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <select
            aria-label="Rang"
            value={(parameters.av_rang as string) ?? ''}
            onChange={(e) => onParameter('av_rang', e.target.value)}
            className={veldKlasse()}
          >
            <option value="">Kies…</option>
            {RANGEN.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            aria-label="Weekdag"
            value={(parameters.av_weekdag as string) ?? ''}
            onChange={(e) => onParameter('av_weekdag', e.target.value)}
            className={veldKlasse()}
          >
            <option value="">Kies…</option>
            {WEEKDAGEN.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <span>van</span>
          <MaandKeuze waarde={parameters.av_maand} onKies={(v) => onParameter('av_maand', v)} />
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        {vorm === AV_GEEN_STATUTAIRE_DATUM
          ? 'Staat er geen datum in de statuten, dan geldt de wettelijke uiterste datum: zes maanden na het boekjaareinde.'
          : 'De vergadering moet binnen zes maanden na het boekjaareinde vallen; een datum daarbuiten wordt geweigerd.'}
      </p>
    </div>
  )
}

function MaandKeuze({ waarde, onKies }: { waarde: unknown; onKies: (maand: number | undefined) => void }) {
  return (
    <select
      aria-label="Maand"
      value={typeof waarde === 'number' ? waarde : ''}
      onChange={(e) => onKies(e.target.value === '' ? undefined : Number(e.target.value))}
      className={veldKlasse()}
    >
      <option value="">Kies…</option>
      {MAANDEN.map((m, i) => (
        <option key={m} value={i + 1}>
          {m}
        </option>
      ))}
    </select>
  )
}
