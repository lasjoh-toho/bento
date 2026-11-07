// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Medien section's per-file actions (download, delete, shrink) and its
// lightbox: every embedded file of the deck, viewed one after another at
// full size, with its file size, pixel size and where it is used.

import type { Store } from '../store'
import type { BentoDoc } from '../model'
import { dataUriByteSize, dataUriMimeType, downscaleImageDataUrl, findUsedAssetAndFontKeys, formatBytesMB } from '../model'
import { imageDownscaleParams } from './moodle'
import { ICONS } from '../icons'
import { t } from '../i18n'

export interface AssetEntry {
  key: string
  value: string
  mime: string
  bytes: number
  unused: boolean
  /** family name when the entry is an embedded font */
  font?: string
}

/** doc.assets as a list, largest first — the order the Medien section shows. */
export function assetEntries(doc: BentoDoc): AssetEntry[] {
  const { assetKeys: used } = findUsedAssetAndFontKeys(doc)
  const fontOf = new Map((doc.fonts ?? []).map((f) => [f.asset, f.family]))
  return Object.entries(doc.assets ?? {})
    .map(([key, value]) => ({
      key, value,
      mime: dataUriMimeType(value),
      bytes: dataUriByteSize(value),
      unused: !used.has(key),
      font: fontOf.get(key),
    }))
    .sort((a, b) => b.bytes - a.bytes)
}

export const isImageMime = (mime: string) => mime.startsWith('image/')
export const isFontMime = (mime: string, e?: AssetEntry) =>
  !!e?.font || mime.startsWith('font/') || mime.startsWith('application/font') || mime.includes('woff') || mime.includes('opentype') || mime.includes('truetype')

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'audio/mpeg': 'mp3',
  'video/quicktime': 'mov', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf', 'application/x-font-otf': 'otf',
}

function fileName(e: AssetEntry): string {
  const ext = EXT[e.mime] ?? (e.mime.split('/')[1] ?? '').replace(/^x-/, '').replace(/[^a-z0-9].*$/i, '')
  const base = e.font ? e.font.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') : `bento-${e.key}`
  return `${base || 'bento-media'}.${ext || 'bin'}`
}

export async function downloadAsset(e: AssetEntry) {
  const blob = await (await fetch(e.value)).blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName(e)
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Remove one embedded file (and its font entry) — undoable, see Store.deleteAssets. */
export function deleteAsset(store: Store, key: string) {
  store.commit(() => {
    const doc = store.doc
    if (doc.fonts?.some((f) => f.asset === key)) doc.fonts = doc.fonts.filter((f) => f.asset !== key)
    store.deleteAssets([key])
  })
}

/** What shrinking would give, or null when it would not save anything. */
export async function shrinkPreview(e: AssetEntry): Promise<string | null> {
  if (!isImageMime(e.mime) || e.mime === 'image/svg+xml' || e.mime === 'image/gif') return null
  const { maxDim, quality } = imageDownscaleParams()
  const shrunk = await downscaleImageDataUrl(e.value, maxDim, quality)
  return dataUriByteSize(shrunk) < e.bytes ? shrunk : null
}

export function applyShrunk(store: Store, key: string, shrunk: string) {
  store.commit(() => {
    if (store.doc.assets?.[key] !== undefined) store.doc.assets[key] = shrunk
  })
}

/** Slide numbers (1-based, linear order; an interactive state counts as its
 *  parent's page) whose elements reference `key`. */
export function slidesUsing(doc: BentoDoc, key: string): number[] {
  const ref = `asset:${key}`
  const out: number[] = []
  let page = 0
  const pageOf = new Map<string, number>()
  for (const s of doc.slides) {
    if (!s.stateOf) pageOf.set(s.id, ++page)
    const n = s.stateOf ? pageOf.get(s.stateOf) ?? page : page
    const hit = s.elements.some((el) =>
      (el.type === 'image' && (el.src === ref || el.mask === ref)) ||
      (el.type === 'media' && (el.src === ref || el.poster === ref)) ||
      (el.type === 'svg' && el.asset === key) ||
      (el.type === 'chart' && JSON.stringify(el.option).includes(ref)))
    if (hit && !out.includes(n)) out.push(n)
  }
  return out
}

const el = (tag: string, cls: string, text?: string) => {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function iconButton(icon: string, label: string, cls = '') {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-lb-btn ' + cls
  b.innerHTML = icon
  b.setAttribute('aria-label', label)
  b.title = label
  return b
}

let fontSeq = 0

/** Opens the lightbox on `startKey`. ←/→ step through the files, Esc closes.
 *  Edits made in it (shrink, delete) are ordinary undoable commits; the list
 *  follows the document live, so a delete moves on to the next file. */
export function openMediaLightbox(store: Store, startKey: string) {
  document.querySelector('.ed-lightbox')?.remove()
  let entries = assetEntries(store.doc)
  let index = Math.max(0, entries.findIndex((e) => e.key === startKey))
  const prevFocus = document.activeElement as HTMLElement | null

  const root = el('div', 'ed-lightbox')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', t('Medien'))
  const bar = el('div', 'ed-lb-bar')
  const counter = el('span', 'ed-lb-counter')
  const info = el('div', 'ed-lb-info')
  const actions = el('div', 'ed-lb-actions')
  const shrinkB = iconButton(ICONS.shrink, t('Verkleinern'), 'ed-lb-text')
  const downloadB = iconButton(ICONS.download, t('Herunterladen'))
  const deleteB = iconButton(ICONS.trash, t('Löschen'), 'ed-lb-danger')
  const closeB = iconButton(ICONS.close, t('Schließen'))
  actions.append(shrinkB, downloadB, deleteB, closeB)
  bar.append(counter, info, actions)
  const stage = el('div', 'ed-lb-stage')
  const prevB = iconButton(ICONS.chevronLeft, t('Previous'), 'ed-lb-nav ed-lb-prev')
  const nextB = iconButton(ICONS.chevronRight, t('Next'), 'ed-lb-nav ed-lb-next')
  const strip = el('div', 'ed-lb-strip')
  root.append(bar, stage, prevB, nextB, strip)
  document.body.appendChild(root)

  let shown = -1
  let shrinkFor: string | null = null
  let shrunk: string | null = null

  const renderStrip = () => {
    strip.innerHTML = ''
    entries.forEach((e, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-lb-thumb' + (e.unused ? ' ed-lb-thumb-unused' : '') + (i === index ? ' current' : '')
      b.title = `${i + 1} · ${formatBytesMB(e.bytes)}`
      if (isImageMime(e.mime)) {
        const img = document.createElement('img')
        img.src = e.value
        img.loading = 'lazy'
        img.alt = ''
        b.appendChild(img)
      } else {
        b.textContent = e.mime.startsWith('video/') ? '▶' : e.mime.startsWith('audio/') ? '♪' : isFontMime(e.mime, e) ? 'Aa' : '?'
      }
      b.addEventListener('click', () => { index = i; render() })
      strip.appendChild(b)
    })
  }

  const render = () => {
    if (!entries.length) { close(); return }
    index = Math.min(Math.max(index, 0), entries.length - 1)
    const e = entries[index]
    counter.textContent = `${index + 1} / ${entries.length}`
    prevB.disabled = index === 0
    nextB.disabled = index === entries.length - 1
    root.classList.toggle('ed-lb-is-unused', e.unused)

    info.innerHTML = ''
    const title = el('span', 'ed-lb-title', e.font ? t('Schriftart: {name}', { name: e.font }) : e.mime)
    const size = el('span', 'ed-lb-size', formatBytesMB(e.bytes))
    const dims = el('span', 'ed-lb-dims')
    info.append(title, size, dims)
    if (e.unused) info.appendChild(el('span', 'ed-lb-badge', t('nicht mehr verwendet')))
    else {
      const pages = slidesUsing(store.doc, e.key)
      if (pages.length) info.appendChild(el('span', 'ed-lb-used', t('Folie {list}', { list: pages.join(', ') })))
    }

    deleteB.hidden = !e.unused
    shrinkB.hidden = true
    if (shrinkFor !== e.key) { shrinkFor = e.key; shrunk = null }
    if (isImageMime(e.mime)) {
      void shrinkPreview(e).then((s) => {
        if (shrinkFor !== e.key) return
        shrunk = s
        shrinkB.hidden = !s
        if (s) shrinkB.innerHTML = `${ICONS.shrink}<span>${t('Verkleinern auf {size}', { size: formatBytesMB(dataUriByteSize(s)) })}</span>`
      })
    }

    if (shown !== index || stage.dataset.key !== e.key) {
      shown = index
      stage.dataset.key = e.key
      stage.innerHTML = ''
      let media: HTMLElement
      if (isImageMime(e.mime)) {
        const img = document.createElement('img')
        img.className = 'ed-lb-media'
        img.alt = ''
        img.onload = () => { dims.textContent = `${img.naturalWidth} × ${img.naturalHeight} px` }
        img.src = e.value
        media = img
      } else if (e.mime.startsWith('video/')) {
        const v = document.createElement('video')
        v.className = 'ed-lb-media'
        v.controls = true
        v.onloadedmetadata = () => { dims.textContent = `${v.videoWidth} × ${v.videoHeight} px` }
        v.src = e.value
        media = v
      } else if (e.mime.startsWith('audio/')) {
        const a = document.createElement('audio')
        a.controls = true
        a.src = e.value
        media = a
      } else if (isFontMime(e.mime, e)) {
        const family = `bento-lb-font-${++fontSeq}`
        media = el('div', 'ed-lb-font')
        media.innerHTML = '<div>Aa Bb Cc Dd Ee Ff Gg</div><div>Äö Üß 0123456789 &amp; ?!</div><div>The quick brown fox jumps over the lazy dog</div>'
        media.style.fontFamily = `${family}, sans-serif`
        try {
          const face = new FontFace(family, `url(${e.value})`)
          void face.load().then((f) => { document.fonts.add(f) }, () => {})
        } catch { /* unreadable font — the sample stays in the fallback face */ }
      } else {
        media = el('div', 'ed-lb-font', t('Keine Vorschau für diesen Dateityp.'))
      }
      stage.appendChild(media)
      renderStrip()
      strip.querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    } else {
      strip.querySelectorAll('.ed-lb-thumb').forEach((b, i) => b.classList.toggle('current', i === index))
    }
  }

  const off = store.on('doc', () => {
    const key = entries[index]?.key
    entries = assetEntries(store.doc)
    const at = entries.findIndex((e) => e.key === key)
    if (at >= 0) index = at
    shown = -1
    render()
  })

  function close() {
    off()
    document.removeEventListener('keydown', onKey, true)
    root.remove()
    prevFocus?.focus?.()
  }
  const step = (d: number) => { index += d; render() }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close()
    else if (ev.key === 'ArrowLeft') step(-1)
    else if (ev.key === 'ArrowRight') step(1)
    else if (ev.key === 'Home') { index = 0; render() }
    else if (ev.key === 'End') { index = entries.length - 1; render() }
    else return
    ev.preventDefault()
    ev.stopPropagation()
  }
  document.addEventListener('keydown', onKey, true)
  prevB.addEventListener('click', () => step(-1))
  nextB.addEventListener('click', () => step(1))
  closeB.addEventListener('click', close)
  root.addEventListener('click', (ev) => { if (ev.target === root || ev.target === stage) close() })
  downloadB.addEventListener('click', () => { const e = entries[index]; if (e) void downloadAsset(e) })
  deleteB.addEventListener('click', () => { const e = entries[index]; if (e?.unused) deleteAsset(store, e.key) })
  shrinkB.addEventListener('click', () => {
    const e = entries[index]
    if (e && shrunk && shrinkFor === e.key) applyShrunk(store, e.key, shrunk)
  })
  render()
  closeB.focus()
}
