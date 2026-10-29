/**
 * Het intromuziekje onder de begroeting: vijf seconden, opgewekt in de
 * browser zelf (Web Audio). Geen geluidsbestand, dus niets te downloaden en
 * geen licentie op muziek van een ander.
 *
 * Drie lagen, zoals een filmintro:
 *   1. een opbouw: een toon die stijgt, met ruis eronder (0 - 0,8 s);
 *   2. de inslag: een lage dreun en een akkoord in D groot dat openbloeit
 *      (vanaf 0,8 s), dat langzaam uitsterft;
 *   3. een glinstering: vier hoge noten met een echo (vanaf 1,1 s).
 *
 * Sinds het intronummer uit Suno er is (hieronder), speelt dit alleen nog als
 * dat niet laadt. Een browser speelt alleen geluid na een klik op de pagina;
 * die klik is het inloggen zelf.
 */

const VOLUME = 0.22

type AudioContextKlasse = typeof AudioContext

function audioKlasse(): AudioContextKlasse | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextKlasse }).webkitAudioContext
}

export function kanGeluid(): boolean {
  return audioKlasse() !== undefined
}

/**
 * Het eigen intronummer: "Systems Operational", gemaakt in Suno (29/10/2026)
 * -- opstartgeluid met een Britse mannenstem: "Good day, sir. I am ready to
 * assist you. Systems are now fully operational." Dezelfde woorden staan op
 * het scherm (BEGROETING in lib/begroeting.ts). Het is het enige geluid met een
 * stem (29/10/2026: "verwijder alle andere stemmen"); het opgewekte muziekje
 * hieronder speelt alleen nog als het nummer niet laadt.
 *
 * Rechtstreeks van Suno, waar het nummer publiek staat: zo hoeft het niet in
 * de (publieke) repo. Dat betekent wel dat de browser van wie het geluid
 * aanzet bij het inloggen Suno contacteert -- alleen dan, het geluid staat
 * standaard uit. Haalt Suno het weg, of laadt het niet op tijd, dan blijft
 * alles zoals voorheen.
 */
export const INTRO_BESTAND = 'https://cdn1.suno.ai/22c27736-6c75-465f-8c7e-b5e92db7a766.mp3'

export interface Afspelend {
  /** Lengte van het nummer in seconden. */
  duur: number
  /** Stopt het nummer, met een korte fade. */
  stop: () => void
}

/** Speelt het intronummer af; `null` als dat niet lukt binnen `wachtMs`. */
export async function speelIntroBestand(wachtMs = 2500): Promise<Afspelend | null> {
  if (typeof Audio === 'undefined') return null
  const audio = new Audio(INTRO_BESTAND)
  audio.volume = 0.9
  let opgegeven = false
  let gestart: Promise<boolean>
  try {
    // Oudere browsers geven geen belofte terug: dan weten we het niet, en
    // nemen we het zekere voor het onzekere.
    const belofte = audio.play() as Promise<void> | undefined
    gestart = belofte ? belofte.then(() => true, () => false) : Promise.resolve(false)
  } catch {
    gestart = Promise.resolve(false)
  }
  const opTijd = await Promise.race([gestart, new Promise<false>((klaar) => window.setTimeout(() => klaar(false), wachtMs))])
  if (!opTijd) {
    // Te traag of niet gevonden: niet alsnog midden in de rest beginnen.
    opgegeven = true
    audio.pause()
    return null
  }
  return {
    duur: Number.isFinite(audio.duration) ? audio.duration : 0,
    stop: () => {
      if (opgegeven) return
      opgegeven = true
      const begin = audio.volume
      let stap = 0
      const klok = window.setInterval(() => {
        stap++
        audio.volume = Math.max(0, begin * (1 - stap / 12))
        if (stap >= 12) {
          window.clearInterval(klok)
          audio.pause()
        }
      }, 50)
    },
  }
}

export function speelIntro(): void {
  const Klasse = audioKlasse()
  if (!Klasse) return
  let ctx: AudioContext
  try {
    ctx = new Klasse()
  } catch {
    return
  }
  bouwIntro(ctx, ctx.currentTime + 0.05)
  // Opruimen als alles uitgeklonken is.
  window.setTimeout(() => void ctx.close().catch(() => {}), 7000)
}

/** Het muziekje zelf, op eender welke context: ook offline, om het als bestand te beluisteren. */
export function bouwIntro(ctx: BaseAudioContext, t0: number): void {

  // Alles loopt via een compressor en een echo naar de uitgang.
  const meester = ctx.createGain()
  meester.gain.value = VOLUME
  const compressor = ctx.createDynamicsCompressor()
  meester.connect(compressor).connect(ctx.destination)
  const echo = ctx.createDelay()
  echo.delayTime.value = 0.28
  const terugkoppeling = ctx.createGain()
  terugkoppeling.gain.value = 0.35
  echo.connect(terugkoppeling).connect(echo)
  echo.connect(meester)

  // 1. De opbouw.
  const stijger = ctx.createOscillator()
  stijger.type = 'sine'
  stijger.frequency.setValueAtTime(70, t0)
  stijger.frequency.exponentialRampToValueAtTime(440, t0 + 0.8)
  const stijgerVolume = ctx.createGain()
  stijgerVolume.gain.setValueAtTime(0.0001, t0)
  stijgerVolume.gain.exponentialRampToValueAtTime(0.5, t0 + 0.75)
  stijgerVolume.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9)
  stijger.connect(stijgerVolume).connect(meester)
  stijger.start(t0)
  stijger.stop(t0 + 1)

  const ruis = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.9), ctx.sampleRate)
  const kanaal = ruis.getChannelData(0)
  for (let i = 0; i < kanaal.length; i++) kanaal[i] = Math.random() * 2 - 1
  const ruisBron = ctx.createBufferSource()
  ruisBron.buffer = ruis
  const ruisFilter = ctx.createBiquadFilter()
  ruisFilter.type = 'bandpass'
  ruisFilter.frequency.setValueAtTime(400, t0)
  ruisFilter.frequency.exponentialRampToValueAtTime(6000, t0 + 0.8)
  const ruisVolume = ctx.createGain()
  ruisVolume.gain.setValueAtTime(0.0001, t0)
  ruisVolume.gain.exponentialRampToValueAtTime(0.25, t0 + 0.7)
  ruisVolume.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9)
  ruisBron.connect(ruisFilter).connect(ruisVolume).connect(meester)
  ruisBron.start(t0)

  // 2. De inslag: een dreun en een akkoord.
  const inslag = t0 + 0.8
  const dreun = ctx.createOscillator()
  dreun.type = 'sine'
  dreun.frequency.setValueAtTime(110, inslag)
  dreun.frequency.exponentialRampToValueAtTime(40, inslag + 1.2)
  const dreunVolume = ctx.createGain()
  dreunVolume.gain.setValueAtTime(0.9, inslag)
  dreunVolume.gain.exponentialRampToValueAtTime(0.0001, inslag + 1.6)
  dreun.connect(dreunVolume).connect(meester)
  dreun.start(inslag)
  dreun.stop(inslag + 1.7)

  const akkoordFilter = ctx.createBiquadFilter()
  akkoordFilter.type = 'lowpass'
  akkoordFilter.frequency.setValueAtTime(300, inslag)
  akkoordFilter.frequency.exponentialRampToValueAtTime(2400, inslag + 1.4)
  akkoordFilter.frequency.exponentialRampToValueAtTime(600, inslag + 4.2)
  const akkoordVolume = ctx.createGain()
  akkoordVolume.gain.setValueAtTime(0.0001, inslag)
  akkoordVolume.gain.exponentialRampToValueAtTime(0.18, inslag + 0.5)
  akkoordVolume.gain.setValueAtTime(0.18, inslag + 2.4)
  akkoordVolume.gain.exponentialRampToValueAtTime(0.0001, inslag + 4.4)
  akkoordFilter.connect(akkoordVolume).connect(meester)
  akkoordVolume.connect(echo)
  // D, A, d, fis, a: D groot, open gelegd. Per noot twee licht ontstemde
  // zaagtanden, voor een breed, warm geluid.
  for (const frequentie of [73.42, 110, 146.83, 185, 220]) {
    for (const ontstemming of [-6, 6]) {
      const toon = ctx.createOscillator()
      toon.type = 'sawtooth'
      toon.frequency.value = frequentie
      toon.detune.value = ontstemming
      toon.connect(akkoordFilter)
      toon.start(inslag)
      toon.stop(inslag + 4.5)
    }
  }

  // 3. De glinstering.
  ;[587.33, 739.99, 880, 1174.66].forEach((frequentie, i) => {
    const begin = t0 + 1.1 + i * 0.16
    const noot = ctx.createOscillator()
    noot.type = 'triangle'
    noot.frequency.value = frequentie
    const nootVolume = ctx.createGain()
    nootVolume.gain.setValueAtTime(0.0001, begin)
    nootVolume.gain.exponentialRampToValueAtTime(0.16, begin + 0.02)
    nootVolume.gain.exponentialRampToValueAtTime(0.0001, begin + 0.6)
    noot.connect(nootVolume)
    nootVolume.connect(meester)
    nootVolume.connect(echo)
    noot.start(begin)
    noot.stop(begin + 0.7)
  })
}
