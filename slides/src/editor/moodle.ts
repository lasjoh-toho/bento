// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Native Moodle integration. When this file is opened from a mod/bento
// Moodle activity (edit.php), Save posts the document to Moodle's
// mod_bento_save_document web service instead of trying to rewrite/download
// a local file — there's no local file handle in that context; the "file" is
// a database row. Opened any other way (a plain .bento.html, bento.page
// itself), moodleConfig is null and nothing here does anything — Save keeps
// its normal local behaviour untouched.
//
// edit.php supplies the cmid/sesskey/wwwroot this needs via a small
// <meta name="bento-moodle-config"> tag it injects alongside the document
// itself — see mod/bento/edit.php in the Moodle plugin.

export interface MoodleConfig {
  cmid: number
  sesskey: string
  wwwroot: string
  /** Present only when editing a DRAFT deck (bento_decks) rather than the
   *  published bento.document — see mod/bento/edit.php's own ?deckid=
   *  param, which is what this meta tag ultimately reflects. Absent means
   *  "save to the published document", same as before this field existed. */
  deckid?: number
  /** Admin-configured save-request timeout in SECONDS (settings.php's own
   *  "Zeitüberschreitung beim Speichern") — falls back to 20 if somehow
   *  absent (an older mod_bento not yet carrying this field). */
  savetimeout?: number
}

function readMoodleConfig(): MoodleConfig | null {
  // The literal check asked for: presence of "mod/bento" in the URL is what
  // decides whether this is "Bento running inside Moodle" at all — the meta
  // tag lookup below only matters once that's already true, as a second,
  // narrower confirmation (and the actual source of cmid/sesskey/wwwroot).
  if (!location.pathname.includes('mod/bento')) {
    console.log('[bento/moodle] not detected — URL pathname has no "mod/bento":', location.pathname)
    return null
  }
  const meta = document.querySelector('meta[name="bento-moodle-config"]')
  if (!meta) {
    console.log('[bento/moodle] "mod/bento" is in the URL, but no <meta name="bento-moodle-config"> tag was found in <head> — Save will use normal local-file behaviour.')
    return null
  }
  const content = meta.getAttribute('content')
  if (!content) {
    console.log('[bento/moodle] the meta tag exists but has no content attribute.')
    return null
  }
  try {
    const cfg = JSON.parse(content)
    if (cfg && typeof cfg.cmid === 'number' && typeof cfg.sesskey === 'string' && typeof cfg.wwwroot === 'string') {
      console.log('[bento/moodle] detected — saves will go to Moodle. cmid:', cfg.cmid, '| wwwroot:', cfg.wwwroot)
      return cfg as MoodleConfig
    }
    console.log('[bento/moodle] meta tag content parsed but is missing cmid/sesskey/wwwroot:', cfg)
  } catch (e) {
    console.log('[bento/moodle] meta tag content is not valid JSON:', content, e)
  }
  return null
}

/** Read once at module load — the page doesn't navigate without a reload, so this never changes mid-session. */
export const moodleConfig: MoodleConfig | null = readMoodleConfig()

/**
 * Posts `doc` to mod_bento's save web service. Throws with a descriptive
 * message on any failure (network, non-JSON response, or a Moodle exception
 * payload) rather than failing silently — editor.ts surfaces this via the
 * normal save-failed toast.
 */
export async function saveToMoodle(doc: unknown): Promise<{ bytes: number }> {
  if (!moodleConfig) throw new Error('Not running inside a Moodle mod/bento activity')
  const { cmid, sesskey, wwwroot, deckid, savetimeout } = moodleConfig
  const url = `${wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=mod_bento_save_document`
  const tSerializeStart = performance.now()
  const serialized = JSON.stringify(doc)
  const args: Record<string, unknown> = { cmid, document: serialized }
  if (deckid) args.deckid = deckid
  const body = [{ index: 0, methodname: 'mod_bento_save_document', args }]
  console.log(`[bento/moodle] document serialized (${serialized.length} bytes) in ${(performance.now() - tSerializeStart).toFixed(0)}ms — starting fetch to ${url}`)

  // fetch() has no default timeout — a network-level hang (server
  // unreachable, request silently dropped by a proxy/firewall along the
  // way) would otherwise wait forever with no feedback at all: neither
  // save()'s success toast nor its catch-block error toast ever runs if
  // this await itself never resolves OR rejects. Admin-configured (settings.
  // php's own "Zeitüberschreitung beim Speichern", default 20s) rather than
  // a fixed value — a site with larger presentations or a slower server can
  // raise it without needing a code change.
  const timeoutMs = (savetimeout && savetimeout > 0 ? savetimeout : 20) * 1000
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  const tFetchStart = performance.now()
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    console.log(`[bento/moodle] fetch settled: HTTP ${res.status} after ${(performance.now() - tFetchStart).toFixed(0)}ms`)
  } catch (err) {
    console.log(`[bento/moodle] fetch itself threw after ${(performance.now() - tFetchStart).toFixed(0)}ms:`, err)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Zeitüberschreitung — Moodle hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.')
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
  const tBodyStart = performance.now()
  const raw = await res.text()
  console.log(`[bento/moodle] response body read (${raw.length} bytes) in ${(performance.now() - tBodyStart).toFixed(0)}ms`)

  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Moodle antwortete nicht mit JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`)
  // A genuinely successful call always comes back as an array (one entry
  // per call in the batch, per Moodle's AJAX protocol) — anything else
  // (a plain object, typically {error, errorcode, ...}) means the
  // dispatcher itself failed before it got that far: a PHP fatal error,
  // a missing class, something that crashed before per-call wrapping even
  // happened. Checking data[0]?.error alone missed this shape entirely
  // (data[0] on a plain object is just undefined, so the check silently
  // passed) — that is exactly how a real server-side failure here once
  // produced a false "Gespeichert" toast.
  if (!Array.isArray(data)) {
    throw new Error(data?.message || data?.error || 'Speichern fehlgeschlagen (unerwartete Antwort)')
  }
  if (data[0]?.error) {
    throw new Error(data[0].message || data[0].exception?.message || 'Speichern fehlgeschlagen')
  }
  return { bytes: serialized.length }
}
