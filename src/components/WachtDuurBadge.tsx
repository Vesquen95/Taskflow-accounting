import { wachtDuur, wachtTeLang } from '../lib/urgency'

/**
 * Hoelang een taak al op de klant wacht.
 *
 * Staat naast de statusbadge en niet in een eigen kolom: het is een detail
 * van die ene status, en een kolom die bij drieënnegentig van de honderd
 * regels leeg blijft, kost breedte zonder iets te zeggen.
 *
 * Twee tinten, niet vijf. De status zegt al dat er gewacht wordt; deze badge
 * zegt alleen of dat lang genoeg duurt om iets te doen. Vanaf drie weken
 * wordt hij amber -- korter is een klant die nog bezig is, langer betekent
 * dat de vraag ergens is blijven liggen.
 */
export function WachtDuurBadge({ sinds }: { sinds: string | null | undefined }) {
  const duur = wachtDuur(sinds)
  if (!duur) return null
  const lang = wachtTeLang(sinds)
  return (
    <span
      // De titel noemt de datum zelf: de badge vat samen, de tooltip is
      // precies. Wie moet bellen wil weten sinds wanneer, niet "3 weken".
      title={`Wacht op de klant sinds ${new Date(sinds!).toLocaleDateString('nl-BE', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}`}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${
        lang
          ? 'border-amber-300 bg-amber-50 text-amber-800'
          : 'border-slate-200 bg-slate-50 text-slate-600'
      }`}
    >
      {/* "wacht" erbij, want een los getal naast een statusbadge leest als een
          deadline. En bij een lange wachttijd staat er "wacht al": kleur mag
          nooit de enige drager van betekenis zijn, dus draagt het woord het
          mee voor wie de amber tint niet ziet. */}
      {lang ? 'wacht al' : 'wacht'} {duur}
    </span>
  )
}
