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
//   parent → iframe  {bento:'replace', doc}         import result (undoable)
//                    {bento:'toast', message, kind?}
//                    {bento:'save'}                 e.g. before leaving the page
//                    {bento:'title', title}         rename the deck (host shows the title, titleInHost)

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
}

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
