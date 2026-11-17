// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Morph view (Jo, 17.11.2026): two neighbouring slides side by side, every
// pair of elements that morphs into each other joined by a dotted line.
// Elements that also pair with the slide BEFORE the left one, or AFTER the
// right one, get a line leaving the view on that side. Pairing is done by
// clicking an element on one side and then its partner on the other — no
// morph ids to type. Everything runs through store.commit (one undo step
// per pairing) and only ever writes `morphId`, never `id` (see render.ts:
// data-flip-id = morphId || id).

import type { Store } from '../store'
import type { BentoDoc, SlideElement, TextElement } from '../model'
import { morphKey } from '../model'
import { renderSlide } from '../render'
import { ICONS } from '../icons'
import { t } from '../i18n'

const SVGNS = 'http://www.w3.org/2000/svg'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function btn(html: string, label: string, cls = '') {
  const b = el('button', 'ed-mv-btn ' + cls)
  b.type = 'button'
  b.innerHTML = html
  b.title = label
  b.setAttribute('aria-label', label)
  return b
}

/** short readable label of an element */
export function morphElLabel(e: SlideElement): string {
  if (e.type === 'text') {
    const txt = (e as TextElement).html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (txt) return `„${txt.slice(0, 28)}${txt.length > 28 ? '…' : ''}“`
  }
  if (e.name) return e.name
  return t(e.type.charAt(0).toUpperCase() + e.type.slice(1))
}

const setKey = (e: SlideElement, key: string) => {
  if (key === e.id) delete e.morphId
  else e.morphId = key
}

/** Carry a morph chain onward: from slide `from` on, the element keyed
 *  `oldKey` takes `newKey`, as long as the chain continues and nothing on
 *  that slide already uses `newKey`. Keeps B→C pairs when B is re-keyed. */
function rekeyForward(doc: BentoDoc, from: number, oldKey: string, newKey: string) {
  for (let i = from; i < doc.slides.length; i++) {
    const els = doc.slides[i].elements
    const e = els.find((x) => morphKey(x) === oldKey)
    if (!e || els.some((x) => x !== e && morphKey(x) === newKey)) return
    setKey(e, newKey)
  }
}

/** a key not used on this slide: the element's own id if free, else a fresh one */
function freeKey(doc: BentoDoc, idx: number, e: SlideElement, avoid: string): string {
  const used = new Set(doc.slides[idx].elements.filter((x) => x !== e).map(morphKey))
  if (e.id !== avoid && !used.has(e.id)) return e.id
  let k = ''
  do k = `${e.id}-m${Math.random().toString(36).slice(2, 6)}`
  while (used.has(k))
  return k
}

/** Pair `b` (slide bIdx) with `a` (slide bIdx-1): b takes a's key. */
export function pairElements(doc: BentoDoc, bIdx: number, aId: string, bId: string) {
  const a = doc.slides[bIdx - 1]?.elements.find((x) => x.id === aId)
  const b = doc.slides[bIdx]?.elements.find((x) => x.id === bId)
  if (!a || !b) return
  const key = morphKey(a)
  const old = morphKey(b)
  if (old === key) return
  // whoever on slide B held a's key so far is let go (it keeps its own onward chain)
  const clash = doc.slides[bIdx].elements.find((x) => x !== b && morphKey(x) === key)
  if (clash) unpairElement(doc, bIdx, clash.id)
  setKey(b, key)
  rekeyForward(doc, bIdx + 1, old, key)
}

/** Break b's pairing with the slide before it (its pair with the slide after stays). */
export function unpairElement(doc: BentoDoc, bIdx: number, bId: string) {
  const b = doc.slides[bIdx]?.elements.find((x) => x.id === bId)
  if (!b) return
  const old = morphKey(b)
  const next = freeKey(doc, bIdx, b, old)
  setKey(b, next)
  rekeyForward(doc, bIdx + 1, old, next)
}

export function openMorphView(store: Store, startIdx = store.currentIndex) {
  document.querySelector('.ed-morphview')?.remove()
  const prevFocus = document.activeElement as HTMLElement | null
  const doc = () => store.doc
  let aIdx = Math.max(0, Math.min(startIdx, doc().slides.length - 2))
  let picked: { side: 'a' | 'b'; id: string } | null = null

  const root = el('div', 'ed-morphview')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', t('Morph-Ansicht'))
  root.tabIndex = -1
  const bar = el('div', 'ed-mv-bar')
  const prevB = btn(ICONS.chevronLeft, t('Vorheriges Folienpaar'))
  const title = el('div', 'ed-mv-title')
  const nextB = btn(ICONS.chevronRight, t('Nächstes Folienpaar'))
  const hint = el('div', 'ed-mv-hint')
  const closeB = btn(ICONS.close, t('Schließen'), 'ed-mv-close')
  bar.append(prevB, title, nextB, hint, closeB)
  const stage = el('div', 'ed-mv-stage')
  const foot = el('div', 'ed-mv-foot')
  root.append(bar, stage, foot)
  document.body.appendChild(root)

  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'ed-mv-lines')

  function close() {
    off()
    window.removeEventListener('resize', render)
    root.remove()
    prevFocus?.focus?.()
  }

  function commit(fn: (d: BentoDoc) => void) {
    store.commit(() => fn(store.doc))
  }

  function render() {
    const d = doc()
    if (d.slides.length < 2) {
      stage.innerHTML = ''
      stage.appendChild(el('p', 'ed-mv-empty', t('Für Morph braucht es mindestens zwei Folien.')))
      title.textContent = ''
      return
    }
    aIdx = Math.max(0, Math.min(aIdx, d.slides.length - 2))
    const A = d.slides[aIdx]
    const B = d.slides[aIdx + 1]
    const before = d.slides[aIdx - 1]
    const after = d.slides[aIdx + 2]
    title.textContent = t('Folie {a} → Folie {b}', { a: String(aIdx + 1), b: String(aIdx + 2) })
    prevB.disabled = aIdx === 0
    nextB.disabled = aIdx >= d.slides.length - 2
    hint.textContent = picked
      ? t('Jetzt das Gegenstück auf der anderen Folie anklicken (Esc bricht ab).')
      : t('Element links, dann sein Gegenstück rechts anklicken: beide morphen ineinander. Auf das × einer Linie klicken trennt das Paar.')

    stage.innerHTML = ''
    const panes = el('div', 'ed-mv-panes')
    stage.append(panes)
    // fit two slides side by side, leaving room for the lines between and beside them
    const gap = 140
    const side = 70
    const availW = Math.max(200, (stage.clientWidth - gap - 2 * side) / 2)
    const availH = Math.max(120, stage.clientHeight - 90)
    const scale = Math.min(availW / d.size.width, availH / d.size.height)
    const w = d.size.width * scale
    const h = d.size.height * scale

    const keysOf = (s: typeof A | undefined) => new Set((s?.elements ?? []).map(morphKey))
    const keysA = keysOf(A)
    const keysB = keysOf(B)
    const keysBefore = keysOf(before)
    const keysAfter = keysOf(after)

    const boxes = new Map<string, HTMLElement>()
    function pane(slide: typeof A, idx: number, sideKey: 'a' | 'b') {
      const wrap = el('div', 'ed-mv-pane')
      const cap = el('div', 'ed-mv-cap', `${t('Folie')} ${idx + 1}${slide.name ? ' · ' + slide.name : ''}`)
      const frame = el('div', 'ed-mv-frame')
      frame.style.width = `${w}px`
      frame.style.height = `${h}px`
      const surface = renderSlide(slide, d, { svgAsImage: true })
      surface.style.transformOrigin = '0 0'
      surface.style.transform = `scale(${scale})`
      surface.style.pointerEvents = 'none'
      frame.appendChild(surface)
      const other = sideKey === 'a' ? keysB : keysA
      for (const e of slide.elements) {
        const key = morphKey(e)
        const hit = el('button', 'ed-mv-hit')
        hit.type = 'button'
        hit.style.left = `${e.x * scale}px`
        hit.style.top = `${e.y * scale}px`
        hit.style.width = `${Math.max(e.w * scale, 6)}px`
        hit.style.height = `${Math.max(e.h * scale, 6)}px`
        if (e.rotation) hit.style.transform = `rotate(${e.rotation}deg)`
        if (other.has(key)) hit.classList.add('paired')
        if (picked && picked.side === sideKey && picked.id === e.id) hit.classList.add('picked')
        hit.title = `${morphElLabel(e)} · ${t('Morph-Kennung')}: ${key}`
        hit.addEventListener('click', () => {
          if (picked && picked.side !== sideKey) {
            const aId = sideKey === 'a' ? e.id : picked.id
            const bId = sideKey === 'b' ? e.id : picked.id
            picked = null
            commit((dd) => pairElements(dd, aIdx + 1, aId, bId))
            return render()
          }
          picked = picked && picked.id === e.id && picked.side === sideKey ? null : { side: sideKey, id: e.id }
          render()
        })
        frame.appendChild(hit)
        boxes.set(`${sideKey}:${key}`, hit)
      }
      wrap.append(cap, frame)
      const tr = el('div', 'ed-mv-trans')
      if (sideKey === 'b') {
        if (slide.transition === 'morph') tr.textContent = t('Übergang zu dieser Folie: Morph')
        else {
          tr.textContent = t('Übergang zu dieser Folie: {name}', { name: t(slide.transition === 'none' || !slide.transition ? 'None' : slide.transition === 'fade' ? 'Fade' : slide.transition === 'slide' ? 'Push' : 'Zoom') })
          const on = el('button', 'ed-mv-morphon', t('Morph einschalten'))
          on.type = 'button'
          on.addEventListener('click', () => {
            commit((dd) => { dd.slides[aIdx + 1].transition = 'morph' })
            render()
          })
          tr.append(' ', on)
          tr.classList.add('warn')
        }
      } else tr.textContent = slide.transition === 'morph' && idx > 0 ? t('kommt per Morph von Folie {n}', { n: String(idx) }) : ''
      wrap.appendChild(tr)
      return wrap
    }
    panes.append(pane(A, aIdx, 'a'), pane(B, aIdx + 1, 'b'))

    // lines: measured after layout, in stage coordinates
    svg.innerHTML = ''
    stage.appendChild(svg)
    requestAnimationFrame(() => {
      const sr = stage.getBoundingClientRect()
      svg.setAttribute('width', String(sr.width))
      svg.setAttribute('height', String(sr.height))
      const mid = (b: HTMLElement, edge: 'l' | 'r') => {
        const r = b.getBoundingClientRect()
        return { x: (edge === 'l' ? r.left : r.right) - sr.left, y: r.top + r.height / 2 - sr.top }
      }
      const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => {
        const p = document.createElementNS(SVGNS, 'path')
        const dx = Math.max(30, Math.abs(x2 - x1) / 2)
        const d = `M${x1},${y1} C${x1 + (x2 > x1 ? dx : -dx)},${y1} ${x2 - (x2 > x1 ? dx : -dx)},${y2} ${x2},${y2}`
        // dark halo underneath: the line stays visible where it crosses slide content of the same colour
        const halo = document.createElementNS(SVGNS, 'path')
        halo.setAttribute('d', d)
        halo.setAttribute('class', 'ed-mv-halo')
        p.setAttribute('d', d)
        p.setAttribute('class', cls)
        svg.append(halo, p)
        return p
      }
      for (const key of keysA) {
        const a = boxes.get(`a:${key}`)!
        if (keysBefore.has(key)) {
          const p = mid(a, 'l')
          line(p.x, p.y, 6, p.y, 'ed-mv-out')
        }
        if (!keysB.has(key)) continue
        const b = boxes.get(`b:${key}`)!
        const p1 = mid(a, 'r')
        const p2 = mid(b, 'l')
        line(p1.x, p1.y, p2.x, p2.y, 'ed-mv-pair')
        // × in the gap between the slides: unpair
        const gx = (p1.x + p2.x) / 2
        const gy = (p1.y + p2.y) / 2
        const x = document.createElementNS(SVGNS, 'g')
        x.setAttribute('class', 'ed-mv-cut')
        x.setAttribute('transform', `translate(${gx},${gy})`)
        const c = document.createElementNS(SVGNS, 'circle')
        c.setAttribute('r', '9')
        const tx = document.createElementNS(SVGNS, 'path')
        tx.setAttribute('d', 'M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5')
        const tip = document.createElementNS(SVGNS, 'title')
        tip.textContent = t('Paar trennen')
        x.append(tip, c, tx)
        x.addEventListener('click', () => {
          const bEl = doc().slides[aIdx + 1].elements.find((e) => morphKey(e) === key)
          if (!bEl) return
          commit((dd) => unpairElement(dd, aIdx + 1, bEl.id))
          render()
        })
        svg.appendChild(x)
      }
      for (const key of keysB) {
        if (!keysAfter.has(key)) continue
        const p = mid(boxes.get(`b:${key}`)!, 'r')
        line(p.x, p.y, sr.width - 6, p.y, 'ed-mv-out')
      }
    })

    const pairs = [...keysA].filter((k) => keysB.has(k)).length
    foot.textContent = (pairs === 1 ? t('1 Paar zwischen diesen Folien') : t('{n} Paare zwischen diesen Folien', { n: String(pairs) })) +
      (before ? ' · ' + t('Linien nach links: Partner auf Folie {n}', { n: String(aIdx) }) : '') +
      (after ? ' · ' + t('Linien nach rechts: Partner auf Folie {n}', { n: String(aIdx + 3) }) : '')
  }

  prevB.addEventListener('click', () => { aIdx--; picked = null; render() })
  nextB.addEventListener('click', () => { aIdx++; picked = null; render() })
  closeB.addEventListener('click', close)
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      if (picked) { picked = null; render() } else close()
    } else if (ev.key === 'ArrowLeft' && aIdx > 0) { aIdx--; picked = null; render() }
    else if (ev.key === 'ArrowRight' && aIdx < doc().slides.length - 2) { aIdx++; picked = null; render() }
  })
  // changes from elsewhere (undo in the host header, a collaborator) redraw the view
  const off = store.on('doc', () => { if (root.isConnected) render() })
  window.addEventListener('resize', render)
  render()
  root.focus()
}
