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
  /** A sequence of OTHER decks to play through, one at a time, after this
   *  document's own last slide is reached — see view.php's own visible-
   *  decks query for how this list is built (every deck/document
   *  currently marked visible, in sortorder, this one excluded). Each
   *  entry is lazy-loaded (a plain GET, not fetched up front) only once
   *  present mode actually reaches it — this is the whole point: viewing
   *  a long sequence of visible presentations shouldn't require
   *  downloading all of them just to start the first one. Absent or
   *  empty means "just this one document", same as before this existed. */
  playlist?: { url: string }[]
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
 *
 * @param onProgress optional, called repeatedly with a 0..1 fraction as the
 *   document actually uploads — wired to a visible progress bar by
 *   editor.ts's own save(), since a large presentation on a slow
 *   connection/server can take minutes with genuinely nothing to show for
 *   it otherwise (this session's own investigation found the save itself
 *   isn't actually broken at that point, just slow — the missing piece was
 *   ever showing that to the person waiting on it, the same way Moodle's
 *   own plain file-upload form already does for a large file).
 * @param onStart optional, called once with the exact serialized byte
 *   count right after serialization finishes but before the upload
 *   itself begins — lets the caller show the real size immediately
 *   (e.g. on the Save button's own label) without serializing the
 *   document a second time just to find out how big it is.
 */
export async function saveToMoodle(doc: unknown, onProgress?: (fraction: number) => void, onStart?: (bytes: number) => void): Promise<{ bytes: number }> {
  if (!moodleConfig) throw new Error('Not running inside a Moodle mod/bento activity')
  const { cmid, sesskey, wwwroot, deckid, savetimeout } = moodleConfig
  const url = `${wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=mod_bento_save_document`
  const tSerializeStart = performance.now()
  const serialized = JSON.stringify(doc)
  onStart?.(serialized.length)
  const args: Record<string, unknown> = { cmid, document: serialized }
  if (deckid) args.deckid = deckid
  const body = [{ index: 0, methodname: 'mod_bento_save_document', args }]
  const bodyStr = JSON.stringify(body)
  console.log(`[bento/moodle] document serialized (${serialized.length} bytes) in ${(performance.now() - tSerializeStart).toFixed(0)}ms — starting upload to ${url}`)

  // Admin-configured (settings.php's own "Zeitüberschreitung beim
  // Speichern", default 20s) rather than a fixed value — a site with
  // larger presentations or a slower server can raise it without needing a
  // code change. XHR's own .timeout does the same job AbortController did
  // for fetch() — a network-level hang (server unreachable, request
  // silently dropped by a proxy/firewall along the way) would otherwise
  // wait forever with no feedback at all.
  const timeoutMs = (savetimeout && savetimeout > 0 ? savetimeout : 600) * 1000
  const tFetchStart = performance.now()

  const { status, raw } = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.timeout = timeoutMs
    xhr.upload.onprogress = (ev) => {
      if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total)
    }
    xhr.onload = () => {
      console.log(`[bento/moodle] request settled: HTTP ${xhr.status} after ${(performance.now() - tFetchStart).toFixed(0)}ms`)
      resolve({ status: xhr.status, raw: xhr.responseText })
    }
    xhr.ontimeout = () => {
      console.log(`[bento/moodle] request timed out after ${(performance.now() - tFetchStart).toFixed(0)}ms`)
      reject(new Error('Zeitüberschreitung — Moodle hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.'))
    }
    xhr.onerror = () => {
      console.log(`[bento/moodle] request itself threw after ${(performance.now() - tFetchStart).toFixed(0)}ms`)
      reject(new Error('Netzwerkfehler beim Speichern — bitte erneut versuchen.'))
    }
    xhr.send(bodyStr)
  })

  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Moodle antwortete nicht mit JSON (HTTP ${status}): ${raw.slice(0, 200)}`)
  }
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`)
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
