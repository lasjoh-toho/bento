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
  store.commit(() => store.replaceAsset(key, shrunk))
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

/** Re-encode an image at w×h. A PNG that really uses transparency stays
 *  PNG; everything else becomes JPEG at `quality` (0..1). */
export function encodeImage(src: string, w: number, h: number, quality: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      if (!g) { resolve(null); return }
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, w, h)
      let alpha = false
      if (src.startsWith('data:image/png')) {
        const px = g.getImageData(0, 0, w, h).data
        for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { alpha = true; break }
      }
      resolve(alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** The zoom (image px per screen px) at which this image appears as large as
 *  it does at most on a slide in a 1920-px-wide full-screen show — crop and
 *  fit taken into account. null when no image element uses it. */
export function slideZoom(doc: BentoDoc, key: string, natW: number, natH: number): number | null {
  const ref = `asset:${key}`
  const f = 1920 / (doc.size?.width || 1280)
  let z = 0
  for (const s of doc.slides) {
    for (const e of s.elements) {
      if (e.type !== 'image' || e.src !== ref) continue
      const c = e.crop ?? { x: 0, y: 0, w: 1, h: 1 }
      const sx = (e.w * f) / (natW * c.w)
      const sy = (e.h * f) / (natH * c.h)
      z = Math.max(z, !e.crop && e.fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy))
    }
  }
  return z > 0 ? z : null
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
  // zoom (images only): image px per SCREEN px, so 100 % is 1:1 on any display
  const zoomBar = el('div', 'ed-lb-zoombar')
  const zOut = iconButton('−', t('Verkleinern (Zoom)'))
  const zLabel = el('span', 'ed-lb-zoom')
  const zIn = iconButton('+', t('Vergrößern (Zoom)'))
  const zFit = iconButton(t('Einpassen'), t('Einpassen'), 'ed-lb-text')
  const z100 = iconButton('1:1', t('100 % — ein Bildpunkt pro Bildschirmpunkt'), 'ed-lb-text')
  const zSlide = iconButton(t('Wie auf der Folie'), t('So groß, wie das Bild auf einer Folie höchstens erscheint (Vollbild, 1920 px breit)'), 'ed-lb-text')
  const qLabel = el('label', 'ed-lb-quality', t('Qualität'))
  const qSel = document.createElement('select')
  const defQ = Math.round(imageDownscaleParams().quality * 100)
  for (const q of [...new Set([95, 90, 85, 80, 70, 60, defQ])].sort((a, b) => b - a)) {
    const o = document.createElement('option')
    o.value = String(q)
    o.textContent = `${q} %`
    o.selected = q === defQ
    qSel.appendChild(o)
  }
  qLabel.appendChild(qSel)
  const zShrink = iconButton(ICONS.shrink, t('Für diese Zoomgröße verkleinern'), 'ed-lb-text ed-lb-zshrink')
  const zShrinkText = el('span', '', t('Für diese Zoomgröße verkleinern'))
  const zResult = el('small', 'ed-lb-zresult')
  zShrinkText.appendChild(zResult)
  zShrink.appendChild(zShrinkText)
  zoomBar.append(zOut, zLabel, zIn, zFit, z100, zSlide, qLabel, zShrink)
  root.append(bar, stage, prevB, nextB, zoomBar, strip)
  document.body.appendChild(root)

  let shown = -1
  let shrinkFor: string | null = null
  let shrunk: string | null = null

  let img: HTMLImageElement | null = null
  let natW = 0
  let natH = 0
  let zoom = 1
  /** after a shrink: keep the image on screen at the size it had */
  let keepCss: { key: string; w: number } | null = null
  let est: { key: string; data: string } | null = null
  let estTimer = 0
  let estSeq = 0
  const dpr = () => window.devicePixelRatio || 1
  const canReencode = (e: AssetEntry) => isImageMime(e.mime) && e.mime !== 'image/svg+xml' && e.mime !== 'image/gif'
  const fitZoom = () => {
    const cs = getComputedStyle(stage)
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    return Math.min(1, (w * dpr()) / natW, (h * dpr()) / natH)
  }
  const setZoom = (z: number, at?: { x: number; y: number }) => {
    if (!img || !natW) return
    const old = zoom
    zoom = Math.min(8, Math.max(0.02, z))
    const r = stage.getBoundingClientRect()
    const ax = at ? at.x - r.left : stage.clientWidth / 2
    const ay = at ? at.y - r.top : stage.clientHeight / 2
    const px = stage.scrollLeft + ax
    const py = stage.scrollTop + ay
    img.style.width = `${(natW * zoom) / dpr()}px`
    img.style.height = `${(natH * zoom) / dpr()}px`
    stage.scrollLeft = px * (zoom / old) - ax
    stage.scrollTop = py * (zoom / old) - ay
    zLabel.textContent = `${Math.round(zoom * 100)} %`
    stage.classList.toggle('ed-lb-pannable', stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight)
    scheduleEstimate()
  }
  const scheduleEstimate = () => {
    const e = entries[index]
    if (!e || !canReencode(e) || !natW) return
    clearTimeout(estTimer)
    est = null
    zShrink.disabled = true
    zResult.textContent = '…'
    const seq = ++estSeq
    estTimer = window.setTimeout(async () => {
      const w = Math.max(1, Math.round(natW * Math.min(zoom, 1)))
      const h = Math.max(1, Math.round(natH * Math.min(zoom, 1)))
      const data = await encodeImage(e.value, w, h, Number(qSel.value) / 100)
      if (seq !== estSeq) return
      const bytes = data ? dataUriByteSize(data) : Infinity
      // re-encoding what was just shrunk saves a byte or two — not worth a generation loss
      if (data && bytes < e.bytes * 0.95) {
        est = { key: e.key, data }
        zShrink.disabled = false
        zResult.textContent = `${w} × ${h} px · ${formatBytesMB(bytes)} (−${Math.floor((1 - bytes / e.bytes) * 100)} %)`
      } else {
        zResult.textContent = t('würde nicht kleiner')
      }
    }, 250)
  }

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
    zoomBar.hidden = !isImageMime(e.mime)
    qLabel.hidden = zShrink.hidden = !canReencode(e)
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
      img = null
      let media: HTMLElement
      if (isImageMime(e.mime)) {
        const im = document.createElement('img')
        im.className = 'ed-lb-media ed-lb-zoomable'
        im.alt = ''
        im.draggable = false
        im.onload = () => {
          natW = im.naturalWidth
          natH = im.naturalHeight
          dims.textContent = `${natW} × ${natH} px`
          zoom = 1
          const keep = keepCss?.key === e.key ? keepCss.w : 0
          keepCss = null
          setZoom(keep ? (keep * dpr()) / natW : fitZoom())
          const sz = slideZoom(store.doc, e.key, natW, natH)
          zSlide.hidden = !sz
          zSlide.dataset.zoom = String(sz ?? '')
        }
        img = im
        natW = 0
        im.src = e.value
        media = im
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
    clearTimeout(estTimer)
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
    else if (img && (ev.key === '+' || ev.key === '=')) setZoom(zoom * 1.25)
    else if (img && ev.key === '-') setZoom(zoom / 1.25)
    else if (img && ev.key === '0') setZoom(fitZoom())
    else if (img && ev.key === '1') setZoom(1)
    else return
    ev.preventDefault()
    ev.stopPropagation()
  }
  document.addEventListener('keydown', onKey, true)
  prevB.addEventListener('click', () => step(-1))
  nextB.addEventListener('click', () => step(1))
  closeB.addEventListener('click', close)
  let panned = false
  root.addEventListener('click', (ev) => {
    if (panned) { panned = false; return }
    if (ev.target === root || ev.target === stage) close()
  })
  stage.addEventListener('wheel', (ev) => {
    if (!img || !natW) return
    ev.preventDefault()
    setZoom(zoom * Math.pow(1.0015, -ev.deltaY * (ev.deltaMode === 1 ? 33 : 1)), { x: ev.clientX, y: ev.clientY })
  }, { passive: false })
  stage.addEventListener('pointerdown', (ev) => {
    if (!img || ev.button !== 0 || !stage.classList.contains('ed-lb-pannable')) return
    const sx = ev.clientX, sy = ev.clientY, l0 = stage.scrollLeft, t0 = stage.scrollTop
    panned = false
    const move = (m: PointerEvent) => {
      if (Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 3) panned = true
      stage.scrollLeft = l0 - (m.clientX - sx)
      stage.scrollTop = t0 - (m.clientY - sy)
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
  zOut.addEventListener('click', () => setZoom(zoom / 1.25))
  zIn.addEventListener('click', () => setZoom(zoom * 1.25))
  zFit.addEventListener('click', () => setZoom(fitZoom()))
  z100.addEventListener('click', () => setZoom(1))
  zSlide.addEventListener('click', () => { const z = Number(zSlide.dataset.zoom); if (z) setZoom(z) })
  qSel.addEventListener('change', scheduleEstimate)
  zShrink.addEventListener('click', () => {
    const e = entries[index]
    if (!e || !img || est?.key !== e.key) return
    keepCss = { key: e.key, w: img.getBoundingClientRect().width }
    applyShrunk(store, e.key, est.data)
  })
  downloadB.addEventListener('click', () => { const e = entries[index]; if (e) void downloadAsset(e) })
  deleteB.addEventListener('click', () => { const e = entries[index]; if (e?.unused) deleteAsset(store, e.key) })
  shrinkB.addEventListener('click', () => {
    const e = entries[index]
    if (e && shrunk && shrinkFor === e.key) applyShrunk(store, e.key, shrunk)
  })
  render()
  closeB.focus()
}
