// Unattended presentation ("kiosk"/info-screen) options, read from the page
// URL — a deployment concern, never part of the document:
//   ?autostart=yes | ?autoplay=yes | ?kiosk  start presenting on load
//   ?interval=N                                advance every N seconds
//   ?loop                                      wrap from the last slide to the first
//   ?startscreen=yes                           force the click-to-present card (player files)
// Any of autostart/kiosk/interval/loop marks the page UNATTENDED: nobody is
// there to answer a dialog, so the editor's start-up prompts (crash
// recovery, file-access notices) are suppressed and no scrollbar may ever
// show — see main.ts, editor.wireAutosave and the html.bento-unattended CSS.

export interface KioskParams {
  /** explicitly asked to start presenting on load */
  autostart: boolean
  /** ?startscreen=yes — the click-to-present card always wins */
  startScreen: boolean
  loop: boolean
  intervalMs?: number
  /** any unattended option is set */
  unattended: boolean
}

const YES = ['yes', '1', 'true', 'on']

export function readKioskParams(search: string = location.search): KioskParams {
  const p = new URLSearchParams(search)
  const yes = (k: string) => YES.includes((p.get(k) ?? '').toLowerCase())
  const autostart = yes('autostart') || yes('autoplay') || p.has('kiosk')
  const seconds = parseFloat(p.get('interval') ?? '')
  const intervalMs = seconds > 0 ? seconds * 1000 : undefined
  const loop = p.has('loop') && !['no', '0', 'false', 'off'].includes((p.get('loop') ?? '').toLowerCase())
  return { autostart, startScreen: yes('startscreen'), loop, intervalMs, unattended: autostart || loop || !!intervalMs }
}

export const kiosk: KioskParams = readKioskParams()

// Applied as early as possible (this module is imported by main.ts before
// the app boots), so not even a first-frame scrollbar flashes.
if (kiosk.unattended) document.documentElement.classList.add('bento-unattended')
