// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Generic external-host integration, parallel to moodle.ts: when a page
// embedding this app declares a <meta name="bento-host-config"> tag, Save
// posts the full rebuilt file back to that host's own saveUrl instead of
// downloading a copy or (absent a local file handle) doing nothing in
// place. Unlike moodle.ts this carries NO url-pathname restriction — any
// host that writes the meta tag into a page it serves gets this behaviour,
// since there is no single fixed mount point (moodle.ts's own "mod/bento"
// check) to key off. First consumer: Infomaster's bento.php — a deck saved
// there embeds this meta tag pointing back at itself, so reopening that
// exact file and saving again overwrites it in place on the server, the
// same way a Moodle mod/bento activity does.
import type { BentoDoc } from '../model'
import { serializeAuto, suggestedFileName } from '../save'

export interface HostConfig {
  /** URL Save posts the full rebuilt .bento.html to (multipart/form-data). */
  saveUrl: string
  /** Where the topbar wordmark should navigate (same tab) instead of its
   *  normal "open the About dialog" behaviour. */
  homeUrl: string
  /** Optional label for the host, used in the wordmark's tooltip
   *  ("Back to {host}"); a generic fallback is used when absent. */
  homeLabel?: string
  /** Form field name the full HTML is POSTed under.
   *  Defaults to 'bento_save_html' (Infomaster's bento.php convention). */
  fileField?: string
}

function readHostConfig(): HostConfig | null {
  const meta = document.querySelector('meta[name="bento-host-config"]')
  if (!meta) return null
  const content = meta.getAttribute('content')
  if (!content) {
    console.log('[bento/host] the meta tag exists but has no content attribute.')
    return null
  }
  try {
    const cfg = JSON.parse(content)
    if (cfg && typeof cfg.saveUrl === 'string' && typeof cfg.homeUrl === 'string') {
      console.log('[bento/host] detected — saves will go to', cfg.saveUrl)
      return cfg as HostConfig
    }
    console.log('[bento/host] meta tag content parsed but is missing saveUrl/homeUrl:', cfg)
  } catch (e) {
    console.log('[bento/host] meta tag content is not valid JSON:', content, e)
  }
  return null
}

/** Read once at module load — the page doesn't navigate without a reload, so this never changes mid-session. */
export const hostConfig: HostConfig | null = readHostConfig()

/**
 * Rebuilds the FULL current file (the same self-contained serializer the
 * local-file write-back and download paths already use) and posts it to
 * hostConfig.saveUrl as multipart/form-data. Mirrors saveToMoodle's shape
 * (onProgress/onStart) so editor.ts's save() can treat both the same way.
 */
export async function saveToHost(doc: BentoDoc, onProgress?: (fraction: number) => void, onStart?: (bytes: number) => void): Promise<{ bytes: number }> {
  if (!hostConfig) throw new Error('Not embedded with a <meta name="bento-host-config"> tag.')
  const html = await serializeAuto(doc)
  onStart?.(html.length)

  const fd = new FormData()
  fd.append(hostConfig.fileField || 'bento_save_html', new Blob([html], { type: 'text/html' }), suggestedFileName(doc))
  fd.append('bento_filename', suggestedFileName(doc))

  const { status, raw } = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', hostConfig!.saveUrl)
    xhr.upload.onprogress = (ev) => {
      if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total)
    }
    xhr.onload = () => resolve({ status: xhr.status, raw: xhr.responseText })
    xhr.onerror = () => reject(new Error('Network error while saving to the server.'))
    xhr.send(fd)
  })

  if (status < 200 || status >= 300) throw new Error(`Server responded with HTTP ${status}: ${raw.slice(0, 300)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Server response was not valid JSON: ' + raw.slice(0, 300))
  }
  const ok = (parsed as { ok?: boolean } | null)?.ok
  if (!ok) throw new Error((parsed as { error?: string } | null)?.error || 'Server reported failure saving the file.')
  return { bytes: html.length }
}
