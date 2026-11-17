// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Generic web-app hosting (first user: Collegare). A host serves the shell
// with the document spliced into #bento-doc and adds
//
//   <meta name="bento-host-config" data-bento-transient content='{…}'>
//
// Then Save PUTs the document JSON to `saveUrl` (same origin, cookies carry
// the session) instead of rewriting a local file, the ribbon is on by
// default, and the File menu's PowerPoint/HTML/JSON entries are handed to the
// parent window via postMessage — the host owns its converters (they need not
// share Bento's license, and Bento never bundles them).
//
// The meta tag is transient (kernel save.ts strips it), so a copy saved or
// exported from a hosted deck is an ordinary standalone file again.
//
// Messages (both directions carry `bento: <type>`; origin must match ours):
//   iframe → parent  {bento:'ready'}
//                    {bento:'saved', version}
//                    {bento:'file', action, doc?, snapshots?}   action ∈ FileActionName;
//                    snapshots = SVG still of every chart for exportPptx, key 'slideId/elementId'
//                    {bento:'dirty', dirty}
//                    {bento:'title', title}         deck title (at ready and on change)
//                    {bento:'history', canUndo, canRedo, entries?}   after every edit (undoInHost); entries =
//                                                   {undo:[{label,slide,at}], redo:[…]} when asked with history-get
//                    {bento:'insert', kind, edit?, text?}  open the host's editor for `kind` (one of `inserts`);
//                                                   edit = {id, data} when an element made there is edited again;
//                                                   text = start text when it is applied to a text box (the result
//                                                   then replaces the box, or sits over it for a selection)
//   parent → iframe  {bento:'replace', doc}         import result (undoable)
//                    {bento:'toast', message, kind?}
//                    {bento:'save'}                 e.g. before leaving the page
//                    {bento:'title', title}         rename the deck (host shows the title, titleInHost)
//                    {bento:'undo'} · {bento:'redo'} · {bento:'history-go', steps}   (−n undoes n, +n redoes n)
//                    {bento:'history-get'}          answer with the history list
//                    {bento:'inserted', kind, svg?, tex?, data?, editId?}
//                                                   editor result: svg → picture with `source` (data kept for
//                                                   editing again), tex → text box with $$…$$ math;
//                                                   editId replaces that element instead of adding one

export type FileActionName = 'exportPptx' | 'exportHtml' | 'exportJson' | 'importPptx' | 'importHtml' | 'importJson'

export interface HostConfig {
  /** shown in toasts: "Saved to {name}" */
  name: string
  /** PUT target for {doc, version}; answers {version} or 409 */
  saveUrl: string
  /** optimistic-concurrency token of the version this shell was served with */
  version?: number | string
  /** ribbon on unless the viewer switched it off */
  ribbon?: boolean
  /** File-menu actions the host implements (absent = Bento's own fallback) */
  fileActions?: FileActionName[]
  /** false hides every import entry — e.g. students until a teacher allows it */
  canImport?: boolean
  /** look and present only (a teacher viewing a group's deck); Save is off */
  readOnly?: boolean
  /** the host's own header shows (and edits) the title and the saved state — Bento's chrome leaves both out */
  titleInHost?: boolean
  /** editors the host offers under Insert (loaded by the host only when used) */
  inserts?: HostInsertKind[]
  /** the host's header carries undo/redo and the history list — Bento's chrome leaves them out */
  undoInHost?: boolean
  /** images from other tabs: the host fetches them server-side (no CORS) — URL prefix, the image URL is appended encoded */
  imageProxy?: string
  /** author/licence/page for a web image — URL prefix answering {credit, license, title, origin} (see webimage.ts) */
  imageInfo?: string
  /** false keeps web images out (e.g. students until a teacher allows it); images from the host's own origin still arrive */
  webImages?: boolean
  /** toast shown when a web image is refused (webImages false) */
  webImagesHint?: string
}

export type HostInsertKind = 'wordart' | 'shape' | 'formula'

function readHostConfig(): HostConfig | null {
  const meta = document.querySelector('meta[name="bento-host-config"]')
  const content = meta?.getAttribute('content')
  if (!content) return null
  try {
    const cfg = JSON.parse(content)
    if (cfg && typeof cfg.saveUrl === 'string' && typeof cfg.name === 'string') return cfg as HostConfig
  } catch (e) {
    console.warn('[bento/host] bento-host-config is not valid JSON', e)
  }
  return null
}

/** Read once: the page never navigates without a reload. */
export const hostConfig: HostConfig | null = readHostConfig()

let version = hostConfig?.version

/** Thrown when someone else saved in between — the deck must be reloaded. */
export class HostConflictError extends Error {}

export async function saveToHost(doc: unknown): Promise<{ bytes: number }> {
  if (!hostConfig) throw new Error('Not hosted')
  const body = JSON.stringify({ doc, version })
  const res = await fetch(hostConfig.saveUrl, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body,
  })
  if (res.status === 409) throw new HostConflictError('conflict')
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j?.error) msg = String(j.error)
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  try {
    const j = await res.json()
    if (j && j.version !== undefined) version = j.version
  } catch { /* empty answer is fine */ }
  postToHost({ bento: 'saved', version })
  return { bytes: body.length }
}

export function postToHost(msg: Record<string, unknown>) {
  if (!hostConfig || window.parent === window) return
  try {
    window.parent.postMessage(msg, location.origin)
  } catch { /* cross-origin parent: nothing to tell */ }
}

export function hostHas(action: FileActionName): boolean {
  return !!hostConfig?.fileActions?.includes(action)
}

/** Listen for the parent's messages (same origin only). */
export function onHostMessage(fn: (msg: { bento: string; [k: string]: unknown }) => void) {
  if (!hostConfig) return
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || ev.source !== window.parent) return
    const d = ev.data
    if (d && typeof d === 'object' && typeof d.bento === 'string') fn(d)
  })
}
