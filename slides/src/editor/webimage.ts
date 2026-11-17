// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Images dragged or pasted from other browser tabs.
//
// What a browser hands over when an image is dragged from another page: the
// image's address (text/uri-list), a small piece of HTML with the <img> (and
// the link around it when the picture is linked), sometimes the file itself.
// It never says which PAGE the picture came from. So the citation's sourceUrl
// is the surrounding link when that points at a page, otherwise the image's own
// address — and a host can fill in author, licence and page (Collegare does
// for Wikimedia and for linked pages, via `imageInfo`).
//
// Reading the bytes of a cross-origin image is blocked by CORS unless that
// site allows it. That is a browser rule, not a server one, so a host can fetch
// the image on its server and hand it back from its own origin: `imageProxy`
// (host) or `imageproxy` (mod_bento). Without one, only CORS-friendly images
// arrive, and the toast says why the others did not.
//
// A host may also keep web images out of the deck (`webImages: false`, e.g.
// students until a teacher allows it); images from the host's own origin —
// Collegare's "Notizen und Quellen", dragged across with
// application/x-bento-image — are always welcome.

import type { Citation } from '../model'
import { hostConfig } from './host'
import { moodleConfig } from './moodle'

export const WEB_IMAGE_MAX = 12
/** a host's own drag format: {url, alt, citation} — the image plus where it came from */
export const BENTO_IMAGE_MIME = 'application/x-bento-image'

export interface WebImage {
  url?: string
  file?: File
  alt: string
  /** link around the image, when it points at a page */
  page: string | null
  /** already known (host drag) */
  citation?: Partial<Citation> & { license?: string }
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i
const isHttp = (u: string) => /^https?:\/\//i.test(u)
const looksLikeImage = (u: string) => IMG_EXT.test(u) || /^https?:\/\/upload\.wikimedia\.org\//i.test(u)
export const isOwnOrigin = (u: string) => {
  try { return new URL(u, location.href).origin === location.origin } catch { return false }
}

/** worth offering a drop for (dragover)? Never for Bento's own slide/layer drags. */
export function mayHoldWebImages(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const t = [...dt.types]
  if (t.includes('text/bento-slide')) return false
  return t.includes(BENTO_IMAGE_MIME) || t.includes('text/uri-list') || t.includes('text/html')
}

/** Images in a drop or paste that came from the web (files are handled by the existing path). */
export function webImagesFrom(dt: DataTransfer): WebImage[] {
  const own = dt.getData(BENTO_IMAGE_MIME)
  if (own) {
    try {
      const d = JSON.parse(own)
      if (d && typeof d.url === 'string') return [{ url: d.url, alt: String(d.alt ?? ''), page: null, citation: d.citation ?? undefined }]
    } catch { /* not ours after all */ }
  }
  const out: WebImage[] = []
  const html = dt.getData('text/html')
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const seen = new Set<string>()
    doc.querySelectorAll('img').forEach((img) => {
      const src = (img.getAttribute('src') ?? '').trim()
      if (!isHttp(src) || seen.has(src) || out.length >= WEB_IMAGE_MAX) return
      seen.add(src)
      const a = img.closest('a')?.getAttribute('href') ?? ''
      out.push({ url: src, alt: (img.getAttribute('alt') ?? '').trim().slice(0, 300), page: isHttp(a) && !looksLikeImage(a) ? a : null })
    })
  }
  if (out.length) return out
  const uri = (dt.getData('text/uri-list') || dt.getData('text/x-moz-url'))
    .split(/\r?\n/).map((x) => x.trim()).find((x) => x && !x.startsWith('#') && isHttp(x))
  return uri && looksLikeImage(uri) ? [{ url: uri, alt: '', page: null }] : []
}

/** the host's proxy address for `url`, if it has one */
function proxyFor(url: string): string | null {
  if (hostConfig?.imageProxy) return hostConfig.imageProxy + encodeURIComponent(url)
  const m = moodleConfig?.imageproxy
  return m ? m + (m.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url) : null
}

export const hasImageProxy = () => !!(hostConfig?.imageProxy || moodleConfig?.imageproxy)

/** web images allowed here? (images from the host's own origin always are) */
export function webImagesAllowed(img: WebImage): boolean {
  if (!img.url || isOwnOrigin(img.url)) return true
  return hostConfig?.webImages !== false
}

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => resolve(null)
    r.readAsDataURL(blob)
  })
}

async function tryFetch(url: string, init?: RequestInit): Promise<Blob | null> {
  try {
    const res = await fetch(url, init)
    if (!res.ok) return null
    const b = await res.blob()
    return b.type.startsWith('image/') ? b : null
  } catch {
    return null
  }
}

/** The image as a data: URL — directly when CORS allows, else through the host's proxy. */
export async function fetchWebImage(url: string): Promise<string | null> {
  const own = isOwnOrigin(url)
  const direct = await tryFetch(url, own ? { credentials: 'same-origin' } : { mode: 'cors', credentials: 'omit' })
  if (direct) return blobToDataUrl(direct)
  const p = !own && proxyFor(url)
  const viaProxy = p ? await tryFetch(p, { credentials: 'same-origin' }) : null
  return viaProxy ? blobToDataUrl(viaProxy) : null
}

/** Author, title, licence and page from the host, if it can tell (Collegare: Wikimedia, linked pages). */
export async function lookUpCitation(img: WebImage): Promise<Citation> {
  const today = new Date().toISOString().slice(0, 10)
  const base: Citation = { sourceUrl: img.page ?? img.url ?? '', retrievedAt: today, ...(img.citation ?? {}) }
  if (img.citation?.sourceUrl || !img.url || !hostConfig?.imageInfo || isOwnOrigin(img.url)) return withLicense(base)
  try {
    const res = await fetch(hostConfig.imageInfo + encodeURIComponent(img.url) + (img.page ? '&seite=' + encodeURIComponent(img.page) : ''), { credentials: 'same-origin' })
    if (!res.ok) return base
    const j = await res.json()
    return withLicense({
      ...base,
      ...(j.credit ? { author: String(j.credit) } : {}),
      ...(j.title ? { title: String(j.title) } : {}),
      ...(j.origin ? { sourceUrl: String(j.origin) } : {}),
      ...(j.license ? { license: String(j.license) } : {}),
    } as Citation & { license?: string })
  } catch {
    return base
  }
}

/** Citation has no licence field: it goes into the caption after the author ("Name, CC BY-SA 4.0"). */
function withLicense(c: Citation & { license?: string }): Citation {
  const { license, ...rest } = c
  if (!license) return rest
  return { ...rest, author: [rest.author, license].filter(Boolean).join(', ') }
}
