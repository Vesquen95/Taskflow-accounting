import { useRef, useState } from 'react'
import { Modal } from './Modal'
import {
  KOLOMMEN,
  KlantImportFout,
  kort,
  MAX_BESTAND_BYTES,
  MAX_RIJEN,
  type ImportRij,
  type ImportVoorbeeld,
  type NieuweKlant,
  type VerplichtingKeuze,
} from '../lib/klantImport'
import { SJABLOON_BESTANDSNAAM, downloadSjabloon, leesKlantenBestand } from '../lib/klantImportBestand'
import { useTeams } from '../hooks/useTeams'
import { voerKlantImportUit, type ImportVerslag } from '../lib/klantImportOpslag'
import { reportError } from '../lib/errorMessage'

/**
 * Klanten importeren uit een Excel-bestand.
 *
 * De volgorde is de hele bedoeling van dit scherm: bestand kiezen → voorbeeld
 * met per rij het oordeel → pas dán opslaan, en daarna een verslag per rij.
 * Er gaat niets naar de databank voor het kantoor het gezien heeft.
 *
 * Het parsen zelf (en dus de zware bibliotheken) zit achter een dynamische
 * import in src/lib/klantImportBestand.ts; dit bestand blijft schermwerk.
 */

type Stap =
  | { naam: 'kiezen' }
  | { naam: 'lezen' }
  | { naam: 'voorbeeld'; voorbeeld: ImportVoorbeeld }
  | { naam: 'opslaan'; voorbeeld: ImportVoorbeeld }
  | { naam: 'verslag'; verslag: ImportVerslag }

function telWoord(aantal: number, enkelvoud: string, meervoud: string): string {
  return `${aantal} ${aantal === 1 ? enkelvoud : meervoud}`
}

/** Wat er letterlijk in de cel stond, ingekort: die tekst komt uit een
 *  bestand van buiten en kan duizenden tekens lang zijn. */
function ruweCel(rij: ImportRij, sleutel: keyof ImportRij['ruw'], maxLengte = 60): string {
  return kort(rij.ruw[sleutel] ?? '', maxLengte)
}

function toonWaarde(rij: ImportRij, sleutel: keyof NieuweKlant): string {
  const klant = rij.klant
  // Een ongeldige rij toont wat er écht in de cel stond.
  if (klant === null) return ruweCel(rij, sleutel as keyof ImportRij['ruw'])
  const waarde = klant[sleutel]
  if (waarde === null) return '—'
  if (typeof waarde === 'boolean') return waarde ? 'Ja' : 'Nee'
  return String(waarde)
}

/** Wat er straks voor deze klant aangevinkt wordt, in de woorden van het
 *  sjabloon. Zonder deze kolom blijft een vinkje in Excel onzichtbaar tot na
 *  het opslaan -- en dan staat er al een dossier met de verkeerde deadlines. */
function verplichtingenTekst(rij: ImportRij): string {
  if (rij.verplichtingen.length === 0) return 'Geen'
  return rij.verplichtingen.map(keuzeTekst).join(', ')
}

/** De naam van de verplichting, met de instellingen erachter wanneer het
 *  bestand er meegaf. Zonder die instellingen op het scherm zie je pas na het
 *  opslaan of "1 maand voor AV" ook echt zo gelezen is. */
function keuzeTekst(keuze: VerplichtingKeuze): string {
  const kop = KOLOMMEN.find((k) => k.sleutel === keuze.code)?.kop ?? keuze.code
  const p = keuze.parameters
  const delen: string[] = []
  if (p.basis === 'voor_av') delen.push(`${p.maanden_voor_av} mnd voor AV`)
  else if (p.basis === 'boekjaar') delen.push(`${p.sla_maanden} mnd na boekjaar`)
  if (p.av_vorm === 'vaste_datum') delen.push(`${p.av_dag}/${p.av_maand}`)
  else if (p.av_vorm === 'nde_weekdag') delen.push(`${p.av_rang} ${p.av_weekdag} van ${MAANDNAMEN_KORT[(p.av_maand as number) - 1]}`)
  if (p.frequentie) delen.push(String(p.frequentie))
  if (p.termijn_dagen) delen.push(`${p.termijn_dagen} d`)
  return delen.length === 0 ? kop : `${kop} (${delen.join(', ')})`
}

const MAANDNAMEN_KORT = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
]

function VoorbeeldTabel({ rijen }: { rijen: ImportRij[] }) {
  return (
    <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-2 py-1.5">Rij</th>
            <th className="px-2 py-1.5">Naam</th>
            <th className="px-2 py-1.5">Ondernemingsnr.</th>
            <th className="px-2 py-1.5">Rechtsvorm</th>
            <th className="px-2 py-1.5">Boekjaar</th>
            <th className="px-2 py-1.5">BTW</th>
            <th className="px-2 py-1.5">Fiscaal mandaat</th>
            <th className="px-2 py-1.5">Verplichtingen</th>
            <th className="px-2 py-1.5">Beoordeling</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rijen.map((rij) => (
            <tr key={rij.excelRij} className={rij.klant === null ? 'bg-red-50/60' : undefined}>
              <td className="px-2 py-1.5 tabular-nums text-slate-500">{rij.excelRij}</td>
              <td className="px-2 py-1.5 font-medium text-slate-800">{toonWaarde(rij, 'naam')}</td>
              <td className="px-2 py-1.5 text-slate-600">{toonWaarde(rij, 'ondernemingsnummer')}</td>
              <td className="px-2 py-1.5 text-slate-600">{toonWaarde(rij, 'rechtsvorm')}</td>
              <td className="px-2 py-1.5 text-slate-600">
                {rij.klant
                  ? `${rij.klant.boekjaar_einde_dag}/${rij.klant.boekjaar_einde_maand}`
                  : `${ruweCel(rij, 'boekjaar_einde_dag', 8)}/${ruweCel(rij, 'boekjaar_einde_maand', 8)}`}
              </td>
              <td className="px-2 py-1.5 text-slate-600">
                {rij.klant
                  ? `${rij.klant.btw_regime}${rij.klant.btw_aangifte_frequentie ? ` (${rij.klant.btw_aangifte_frequentie})` : ''}`
                  : ruweCel(rij, 'btw_regime', 40)}
              </td>
              <td className="px-2 py-1.5 text-slate-600">{verplichtingenTekst(rij)}</td>
              <td className="px-2 py-1.5">
                {rij.klant === null ? (
                  <ul className="space-y-0.5 text-red-700">
                    {rij.fouten.map((fout) => (
                      <li key={fout}>{fout}</li>
                    ))}
                  </ul>
                ) : rij.waarschuwingen.length > 0 ? (
                  <ul className="space-y-0.5 text-amber-700">
                    {rij.waarschuwingen.map((waarschuwing) => (
                      <li key={waarschuwing}>{waarschuwing}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-emerald-700">Geldig</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Verslag({ verslag }: { verslag: ImportVerslag }) {
  const mislukt = [...verslag.mislukt, ...verslag.nietGeprobeerd]
  const metOpmerking = verslag.gelukt.filter((u) => u.waarschuwing !== null)
  return (
    <div className="space-y-3 text-sm">
      <p className={mislukt.length === 0 ? 'text-emerald-700' : 'text-slate-700'}>
        {telWoord(verslag.gelukt.length, 'klant aangemaakt', 'klanten aangemaakt')}
        {mislukt.length > 0 && `, ${telWoord(mislukt.length, 'rij mislukt', 'rijen mislukt')}`}.
      </p>
      {verslag.afgebroken && (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          De import is gestopt omdat het meermaals na elkaar misging. De klanten die wél aangemaakt zijn, staan in de
          lijst; de rest kan je opnieuw importeren nadat het probleem hieronder opgelost is.
        </p>
      )}
      {mislukt.length > 0 && (
        <div className="max-h-[40vh] overflow-auto rounded-lg border border-slate-200">
          <ul className="divide-y divide-slate-100 text-xs">
            {mislukt.map((uitkomst) => (
              <li key={uitkomst.excelRij} className="px-3 py-2">
                <span className="font-medium text-slate-700">
                  Rij {uitkomst.excelRij} — {uitkomst.naam}:
                </span>{' '}
                <span className="text-red-700">{uitkomst.reden}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {metOpmerking.length > 0 && (
        <div className="max-h-[30vh] overflow-auto rounded-lg border border-amber-200 bg-amber-50">
          <ul className="divide-y divide-amber-100 text-xs">
            {metOpmerking.map((uitkomst) => (
              <li key={uitkomst.excelRij} className="px-3 py-2 text-amber-800">
                <span className="font-medium">
                  Rij {uitkomst.excelRij} — {uitkomst.naam}:
                </span>{' '}
                {uitkomst.waarschuwing}
              </li>
            ))}
          </ul>
        </div>
      )}
      {verslag.gelukt.length > 0 && (
        <p className="text-xs text-slate-500">
          De taken staan klaar: de btw-taken volgen uit het btw-regime, de overige uit de verplichtingen die je in het
          bestand aanvinkte, met de instellingen die erbij stonden. De neerlegging bij de NBB komt mee met de algemene
          vergadering. Vertrouwelijkheid en een standaard verantwoordelijke stel je per klant in het dossier in.
        </p>
      )}
    </div>
  )
}

export function KlantImportModal({
  bestaandeOndernemingsnummers,
  maakKlant,
  zetVerplichtingen,
  onKlaar,
  onClose,
}: {
  /** Ondernemingsnummers die al in de databank staan, om dubbels te tonen
   *  vóór de unieke index ze weigert. */
  bestaandeOndernemingsnummers: string[]
  maakKlant: (klant: NieuweKlant) => Promise<string>
  /** Zet de taken van een net aangemaakte klant klaar (sync_client_tasks). */
  zetVerplichtingen?: (clientId: string, verplichtingen: VerplichtingKeuze[]) => Promise<void>
  /** Aangeroepen na de import met het aantal aangemaakte klanten. */
  onKlaar: (aantalAangemaakt: number) => void
  onClose: () => void
}) {
  const { teams } = useTeams()
  const [stap, setStap] = useState<Stap>({ naam: 'kiezen' })
  const [fout, setFout] = useState<string | null>(null)
  const bestandRef = useRef<HTMLInputElement>(null)

  async function kiesBestand(bestand: File | undefined) {
    if (!bestand) return
    setFout(null)
    setStap({ naam: 'lezen' })
    try {
      // De teamcodes mee: zonder die lijst zou "ZAV4" stil genegeerd worden en
      // stond er straks een dossier zonder team, zichtbaar voor het hele
      // kantoor, zonder dat iemand het gevraagd had.
      const voorbeeld = await leesKlantenBestand(bestand, {
        bestaandeOndernemingsnummers,
        teamCodes: teams.map((t) => t.code),
      })
      setStap({ naam: 'voorbeeld', voorbeeld })
    } catch (err) {
      setStap({ naam: 'kiezen' })
      setFout(err instanceof KlantImportFout ? err.message : reportError(err, 'Kon het bestand niet lezen'))
    } finally {
      // Zonder dit kan hetzelfde bestand na een correctie niet opnieuw
      // gekozen worden: de input vuurt geen change als de waarde gelijk blijft.
      if (bestandRef.current) bestandRef.current.value = ''
    }
  }

  async function importeer(voorbeeld: ImportVoorbeeld) {
    setFout(null)
    setStap({ naam: 'opslaan', voorbeeld })
    const verslag = await voerKlantImportUit(voorbeeld.rijen, maakKlant, zetVerplichtingen)
    setStap({ naam: 'verslag', verslag })
    onKlaar(verslag.gelukt.length)
  }

  async function haalSjabloon() {
    setFout(null)
    try {
      await downloadSjabloon()
    } catch (err) {
      setFout(reportError(err, 'Kon het sjabloon niet maken'))
    }
  }

  const voorbeeld = stap.naam === 'voorbeeld' || stap.naam === 'opslaan' ? stap.voorbeeld : null

  return (
    <Modal title="Klanten importeren uit Excel" onClose={onClose} breed>
      <div className="space-y-4 text-sm">
        {(stap.naam === 'kiezen' || stap.naam === 'lezen') && (
          <>
            <p className="text-slate-600">
              Gebruik het sjabloon hieronder: het bevat de juiste kolomkoppen, de toegelaten waarden en twee ingevulde
              voorbeeldrijen. Je krijgt eerst een voorbeeld van wat er ingelezen is te zien; er wordt niets opgeslagen
              voor je dat bevestigt.
            </p>
            <div>
              <button
                type="button"
                onClick={haalSjabloon}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Sjabloon downloaden
              </button>
              <span className="ml-2 text-xs text-slate-400">{SJABLOON_BESTANDSNAAM}</span>
            </div>
            <div>
              <label htmlFor="klant-import-bestand" className="mb-1 block text-xs font-medium text-slate-500">
                Excel-bestand (.xlsx)
              </label>
              <input
                id="klant-import-bestand"
                ref={bestandRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                disabled={stap.naam === 'lezen'}
                onChange={(e) => kiesBestand(e.target.files?.[0])}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-slate-700"
              />
              <p className="mt-1 text-xs text-slate-400">
                Hoogstens {MAX_RIJEN} klanten en {MAX_BESTAND_BYTES / (1024 * 1024)} MB per bestand. Verplichte kolommen:{' '}
                {KOLOMMEN.filter((k) => k.vereist)
                  .map((k) => k.kop)
                  .join(', ')}
                .
              </p>
            </div>
            {stap.naam === 'lezen' && <p className="text-slate-400">Bestand lezen…</p>}
          </>
        )}

        {voorbeeld && (
          <>
            <div className="space-y-1">
              <p className="font-medium text-slate-700">
                {voorbeeld.aantalGeldig} van de {telWoord(voorbeeld.rijen.length, 'rij', 'rijen')} in blad "
                {voorbeeld.bladnaam}" {voorbeeld.aantalGeldig === 1 ? 'is' : 'zijn'} geldig.
              </p>
              {voorbeeld.legeRijenOvergeslagen > 0 && (
                <p className="text-xs text-slate-500">
                  {telWoord(voorbeeld.legeRijenOvergeslagen, 'lege rij', 'lege rijen')} overgeslagen.
                </p>
              )}
              {voorbeeld.onbekendeKolommen.length > 0 && (
                <p className="text-xs text-amber-700">
                  Deze kolommen worden niet gebruikt: {voorbeeld.onbekendeKolommen.join(', ')}.
                </p>
              )}
              {voorbeeld.aantalGeldig < voorbeeld.rijen.length && (
                <p className="text-xs text-slate-500">
                  Rijen met een fout worden niet aangemaakt. Verbeter ze in Excel en kies het bestand opnieuw.
                </p>
              )}
            </div>

            <VoorbeeldTabel rijen={voorbeeld.rijen} />
          </>
        )}

        {stap.naam === 'verslag' && <Verslag verslag={stap.verslag} />}

        {fout && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
            {fout}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          {stap.naam === 'voorbeeld' && (
            <button
              type="button"
              onClick={() => setStap({ naam: 'kiezen' })}
              className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            >
              Ander bestand kiezen
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100"
          >
            {stap.naam === 'verslag' ? 'Sluiten' : 'Annuleren'}
          </button>
          {voorbeeld && voorbeeld.aantalGeldig > 0 && (
            <button
              type="button"
              disabled={stap.naam === 'opslaan'}
              onClick={() => importeer(voorbeeld)}
              className="rounded-md bg-brand-600 px-4 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {stap.naam === 'opslaan'
                ? 'Bezig…'
                : `${telWoord(voorbeeld.aantalGeldig, 'klant', 'klanten')} importeren`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
