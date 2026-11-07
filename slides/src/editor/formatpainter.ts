// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Format painter: copy the look of one text or box onto others.
//
// The brush sits in the Typography header (texts) and the Fill & stroke
// header (shapes). Pressing it reads the selected element's properties into
// a dropdown spanning the panel — one pill per property, each removable.
// While the dropdown is open, every element the user selects gets those
// properties. Closing it forgets them, unless the lock is closed: then the
// brush reopens with the same properties instead of reading new ones.
// Purely editor state; nothing here enters the document format.

import type { Store } from '../store'
import type { SlideElement, TextElement } from '../model'
import { firstFamily } from '../fonts'
import { ICONS } from '../icons'
import { t } from '../i18n'

interface PaintProp {
  id: string
  label: string
  /** colour chip drawn in front of the label */
  swatch?: string
  applies(el: SlideElement): boolean
  apply(el: SlideElement): void
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const isText = (el: SlideElement): el is TextElement => el.type === 'text'
const isShape = (el: SlideElement): el is Extract<SlideElement, { type: 'shape' }> => el.type === 'shape'
const fmt = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')

function clearCss(html: string, prop: string): string {
  if (!html.includes(prop)) return html
  const div = document.createElement('div')
  div.innerHTML = html
  div.querySelectorAll<HTMLElement>('[style]').forEach((node) => {
    node.style.removeProperty(prop)
    if (!node.getAttribute('style')?.trim()) node.removeAttribute('style')
  })
  return div.innerHTML
}

/** Is every visible character of `html` inside markup matching `test`? */
function wholly(html: string, test: (node: HTMLElement) => boolean): boolean {
  const div = document.createElement('div')
  div.innerHTML = html
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT)
  let any = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue
    any = true
    let p = n.parentElement
    let hit = false
    while (p && p !== div) {
      if (test(p)) { hit = true; break }
      p = p.parentElement
    }
    if (!hit) return false
  }
  return any
}
const italicTest = (n: HTMLElement) => n.tagName === 'I' || n.tagName === 'EM' || n.style.fontStyle === 'italic'
const underlineTest = (n: HTMLElement) => n.tagName === 'U' || /underline/.test(n.style.textDecoration || n.style.textDecorationLine || '')
const boldTest = (n: HTMLElement) => n.tagName === 'B' || n.tagName === 'STRONG' || parseInt(n.style.fontWeight || '0', 10) >= 600

const ALIGN: Record<string, string> = { left: 'links', center: 'zentriert', right: 'rechts', justify: 'Blocksatz' }
const VALIGN: Record<string, string> = { top: 'oben', middle: 'Mitte', bottom: 'unten' }
const DASH: Record<string, string> = { solid: 'durchgezogen', dashed: 'gestrichelt', dotted: 'gepunktet' }

/** Properties every element type has — they travel between texts and boxes. */
function commonProps(src: SlideElement): PaintProp[] {
  const out: PaintProp[] = []
  if (src.shadow) {
    const shadow = clone(src.shadow)
    out.push({ id: 'shadow', label: t('Schatten'), applies: () => true, apply: (el) => { el.shadow = clone(shadow) } })
  }
  if (src.opacity !== undefined && src.opacity < 1) {
    const o = src.opacity
    out.push({ id: 'opacity', label: t('Deckkraft: {n} %', { n: String(Math.round(o * 100)) }), applies: () => true, apply: (el) => { el.opacity = o } })
  }
  return out
}

function textProps(src: TextElement): PaintProp[] {
  const out: PaintProp[] = []
  const T = (fn: (el: TextElement) => void) => ({ applies: isText, apply: (el: SlideElement) => { if (isText(el)) fn(el) } })
  const family = src.fontFamily
  out.push({ id: 'font', label: t('Schrift: {name}', { name: firstFamily(family) || t('Standard') }), ...T((el) => {
    el.fontFamily = family
    el.html = clearCss(el.html, 'font-family')
  }) })
  const size = src.fontSize
  out.push({ id: 'size', label: t('Größe: {n} pt', { n: fmt(size * 0.75) }), ...T((el) => {
    el.fontSize = size
    el.html = clearCss(el.html, 'font-size')
  }) })
  const markupBold = wholly(src.html, boldTest)
  const weight = markupBold && (src.fontWeight ?? 400) < 600 ? 700 : src.fontWeight ?? 400
  out.push({
    id: 'weight',
    label: weight >= 600 ? (weight === 700 ? t('Fett') : t('Fett ({n})', { n: String(weight) })) : weight === 400 ? t('Nicht fett') : t('Stärke: {n}', { n: String(weight) }),
    ...T((el) => { el.fontWeight = weight }),
  })
  if (wholly(src.html, italicTest)) {
    out.push({ id: 'italic', label: t('Kursiv'), ...T((el) => { if (!wholly(el.html, italicTest)) el.html = `<i>${el.html}</i>` }) })
  }
  if (wholly(src.html, underlineTest)) {
    out.push({ id: 'underline', label: t('Unterstrichen'), ...T((el) => { if (!wholly(el.html, underlineTest)) el.html = `<u>${el.html}</u>` }) })
  }
  if (src.colorGradient) {
    const g = clone(src.colorGradient)
    const color = src.color
    out.push({ id: 'color', label: t('Farbverlauf'), swatch: `linear-gradient(${g.angle}deg, ${g.stops.map((s) => `${s.color} ${s.at * 100}%`).join(', ')})`, ...T((el) => {
      el.color = color
      el.colorGradient = clone(g)
      el.html = clearCss(el.html, 'color')
    }) })
  } else {
    const color = src.color
    out.push({ id: 'color', label: t('Farbe'), swatch: color, ...T((el) => {
      el.color = color
      delete el.colorGradient
      el.html = clearCss(el.html, 'color')
    }) })
  }
  const align = src.align
  out.push({ id: 'align', label: t('Ausrichtung: {v}', { v: t(ALIGN[align] ?? align) }), ...T((el) => { el.align = align }) })
  const valign = src.valign
  out.push({ id: 'valign', label: t('Vertikal: {v}', { v: t(VALIGN[valign] ?? valign) }), ...T((el) => { el.valign = valign }) })
  const lh = src.lineHeight
  out.push({ id: 'lineHeight', label: t('Zeilenhöhe: {n}', { n: fmt(lh) }), ...T((el) => { el.lineHeight = lh }) })
  const ls = src.letterSpacing ?? 0
  out.push({ id: 'letterSpacing', label: t('Laufweite: {n}', { n: fmt(ls) }), ...T((el) => {
    if (ls) el.letterSpacing = ls
    else delete el.letterSpacing
    el.html = clearCss(el.html, 'letter-spacing')
  }) })
  if (src.textStroke?.width) {
    const ts = clone(src.textStroke)
    out.push({ id: 'textStroke', label: t('Textkontur'), swatch: ts.color, ...T((el) => { el.textStroke = clone(ts) }) })
  }
  return [...out, ...commonProps(src)]
}

function shapeProps(src: Extract<SlideElement, { type: 'shape' }>): PaintProp[] {
  const out: PaintProp[] = []
  const S = (fn: (el: Extract<SlideElement, { type: 'shape' }>) => void) => ({ applies: isShape, apply: (el: SlideElement) => { if (isShape(el)) fn(el) } })
  const fill = src.fill
  if (src.fillGradient) {
    const g = clone(src.fillGradient)
    out.push({ id: 'fill', label: t('Füllung: Verlauf'), swatch: `linear-gradient(${g.angle}deg, ${g.stops.map((s) => `${s.color} ${s.at * 100}%`).join(', ')})`, ...S((el) => {
      el.fill = fill
      el.fillGradient = clone(g)
    }) })
  } else {
    out.push({ id: 'fill', label: t('Füllung'), swatch: fill, ...S((el) => { el.fill = fill; delete el.fillGradient }) })
  }
  const stroke = src.stroke
  out.push({ id: 'stroke', label: t('Kontur'), swatch: stroke, ...S((el) => { el.stroke = stroke }) })
  const sw = src.strokeWidth
  out.push({ id: 'strokeWidth', label: t('Konturstärke: {n} px', { n: fmt(sw) }), ...S((el) => { el.strokeWidth = sw }) })
  const style = src.strokeStyle ?? (src.strokeDash ? 'dashed' : 'solid')
  out.push({ id: 'strokeStyle', label: t('Linienart: {v}', { v: t(DASH[style] ?? style) }), ...S((el) => {
    el.strokeStyle = style
    delete el.strokeDash
  }) })
  if (src.shape === 'rect') {
    const r = src.radius
    out.push({
      id: 'radius',
      label: t('Eckenradius: {n} px', { n: fmt(r) }),
      applies: (el) => (isShape(el) && el.shape === 'rect') || el.type === 'image',
      apply: (el) => { if ((isShape(el) && el.shape === 'rect') || el.type === 'image') el.radius = r },
    })
  }
  return [...out, ...commonProps(src)]
}

function propsOf(el: SlideElement): PaintProp[] | null {
  if (isText(el)) return textProps(el)
  if (isShape(el)) return shapeProps(el)
  return null
}

export class FormatPainter {
  private props: PaintProp[] | null = null
  private sourceId: string | null = null
  private locked = false
  private openNow = false
  private drop: HTMLElement | null = null
  private flashTimer = 0

  constructor(private store: Store, private panel: HTMLElement) {
    store.on('selection', () => this.onSelection())
    panel.addEventListener('scroll', () => this.place(), { passive: true })
    document.addEventListener('keydown', (ev) => {
      if (!this.openNow || ev.key !== 'Escape') return
      const inField = ev.target instanceof Element && ev.target.closest('input, textarea, select, [contenteditable="true"]')
      if (inField) return
      ev.preventDefault()
      ev.stopPropagation()
      this.close()
    }, true)
    window.addEventListener('resize', () => this.place())
  }

  /** The grey brush for a section header; `el` is the element it reads from. */
  attach(header: HTMLElement, el: SlideElement) {
    if (!propsOf(el)) return
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-section-tool ed-painter-btn'
    b.innerHTML = ICONS.brush + '<span class="ed-painter-lockdot"></span>'
    b.setAttribute('aria-label', t('Format übertragen'))
    b.setAttribute('aria-pressed', String(this.openNow))
    b.dataset.tooltip = t('Format übertragen — die Eigenschaften dieses Elements auf andere Texte und Kästen übertragen: Pinsel drücken, dann die Ziele anklicken.')
    b.classList.toggle('active', this.openNow)
    b.classList.toggle('locked', this.locked && !!this.props)
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      this.toggle(el.id)
    })
    header.appendChild(b)
    if (this.openNow) requestAnimationFrame(() => this.place())
  }

  private toggle(elId: string) {
    if (this.openNow) { this.close(); return }
    if (!(this.locked && this.props)) {
      const el = this.store.element(elId)
      const props = el && propsOf(el)
      if (!props) return
      this.props = props
      this.sourceId = elId
    }
    this.openNow = true
    this.render()
  }

  private close() {
    this.openNow = false
    if (!this.locked) { this.props = null; this.sourceId = null }
    this.drop?.remove()
    this.drop = null
    document.body.classList.remove('ed-painting')
    this.syncButtons()
  }

  private onSelection() {
    if (!this.openNow || !this.props?.length) return
    const targets = this.store.selectedElements.filter((el) => el.id !== this.sourceId && this.props!.some((p) => p.applies(el)))
    if (!targets.length) return
    const props = this.props
    this.store.commit(() => {
      for (const target of targets) {
        const live = this.store.element(target.id)
        if (!live) continue
        for (const p of props) if (p.applies(live)) p.apply(live)
      }
    })
    if (this.drop) {
      this.drop.classList.add('applied')
      clearTimeout(this.flashTimer)
      this.flashTimer = window.setTimeout(() => this.drop?.classList.remove('applied'), 450)
    }
  }

  private syncButtons() {
    this.panel.querySelectorAll<HTMLElement>('.ed-painter-btn').forEach((b) => {
      b.classList.toggle('active', this.openNow)
      b.classList.toggle('locked', this.locked && !!this.props)
      b.setAttribute('aria-pressed', String(this.openNow))
    })
  }

  private render() {
    if (!this.props) return
    const d = this.drop ?? document.createElement('div')
    d.className = 'ed-painter'
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-label', t('Format übertragen'))
    d.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'ed-painter-head'
    const title = document.createElement('span')
    title.className = 'ed-painter-title'
    title.innerHTML = ICONS.brush
    title.append(t('Format übertragen'))
    const lock = document.createElement('button')
    lock.type = 'button'
    lock.className = 'ed-painter-lock' + (this.locked ? ' on' : '')
    lock.innerHTML = this.locked ? ICONS.lock : ICONS.unlock
    lock.setAttribute('aria-pressed', String(this.locked))
    lock.setAttribute('aria-label', t('Eigenschaften behalten'))
    lock.title = this.locked
      ? t('Gesperrt — die Eigenschaften bleiben erhalten, auch wenn das Fenster geschlossen wird. Klicken zum Entsperren.')
      : t('Sperren — die Eigenschaften bleiben erhalten, auch wenn das Fenster zwischendurch geschlossen wird.')
    lock.addEventListener('click', () => {
      this.locked = !this.locked
      this.render()
      this.syncButtons()
    })
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'ed-painter-close'
    x.innerHTML = ICONS.close
    x.setAttribute('aria-label', t('Schließen'))
    x.title = t('Schließen (Esc)')
    x.addEventListener('click', () => this.close())
    head.append(title, lock, x)

    const hint = document.createElement('p')
    hint.className = 'ed-painter-hint'
    hint.textContent = this.props.length
      ? t('Texte oder Kästen anklicken, um diese Eigenschaften zu übertragen.')
      : t('Keine Eigenschaften mehr ausgewählt.')

    const pills = document.createElement('div')
    pills.className = 'ed-painter-pills'
    for (const p of this.props) {
      const pill = document.createElement('span')
      pill.className = 'ed-painter-pill'
      if (p.swatch) {
        const sw = document.createElement('span')
        sw.className = 'ed-painter-swatch'
        sw.style.background = p.swatch
        pill.appendChild(sw)
      }
      pill.append(p.label)
      const rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'ed-painter-pill-x'
      rm.textContent = '×'
      rm.setAttribute('aria-label', t('{name} nicht übertragen', { name: p.label }))
      rm.addEventListener('click', () => {
        this.props = this.props?.filter((q) => q !== p) ?? null
        this.render()
      })
      pill.appendChild(rm)
      pills.appendChild(pill)
    }
    d.append(head, hint, pills)
    if (!this.drop) {
      this.drop = d
      document.body.appendChild(d)
    }
    document.body.classList.add('ed-painting')
    this.syncButtons()
    this.place()
  }

  /** Under the brush's header, across the panel's content width. */
  private place() {
    const d = this.drop
    if (!d) return
    const pr = this.panel.getBoundingClientRect()
    if (!pr.width) { d.style.display = 'none'; return }
    d.style.display = ''
    const cs = getComputedStyle(this.panel)
    const left = pr.left + this.panel.clientLeft + parseFloat(cs.paddingLeft)
    const width = this.panel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    d.style.left = `${left}px`
    d.style.width = `${width}px`
    const header = this.panel.querySelector<HTMLElement>('.ed-painter-btn')?.closest<HTMLElement>('.ed-section')
    const hr = header?.getBoundingClientRect()
    let top = hr && hr.bottom > pr.top && hr.bottom < pr.bottom ? hr.bottom + 4 : parseFloat(d.style.top) || pr.top + 8
    top = Math.max(pr.top + 4, Math.min(top, window.innerHeight - d.offsetHeight - 8))
    d.style.top = `${top}px`
  }

  /** after the panel rebuilt: new buttons pick up state, the dropdown follows its header */
  afterRebuild() {
    this.syncButtons()
    if (this.openNow) this.place()
  }
}
