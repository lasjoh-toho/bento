// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// PowerPoint-style ribbon (Menüband): an optional second chrome row under the
// topbar with the tabs people know from PowerPoint — File, Home, Insert,
// Design, Transitions, Animations, Slide Show, Review, View. It is a FRONT
// END only: every button calls the same editor/panel/store code the classic
// topbar and the properties panel already use, so the ribbon and the panel
// can never disagree about what a command does. Bento-only features get a
// natural home here too (format painter, embedded fonts, media overview,
// morph, explanations & sources).
//
// On by default when a host asks for it (embed.ts, `ribbon: true`), otherwise
// a per-viewer preference (localStorage 'bento-ribbon') toggled from the
// topbar. The ribbon never enters the document format.
import type { SlideElement, TextElement, TransitionKind } from '../model'
import { defaultShape, defaultText, readableInk } from '../model'
import type { Store } from '../store'
import { FONT_CHOICES, firstFamily } from '../fonts'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { assetEntries, openMediaLightbox } from './medialightbox'

/** What the ribbon needs from the editor — all existing editor methods. */
export interface RibbonHost {
  store: Store
  save(forcePicker: boolean): unknown
  present(fromStart?: boolean, fullscreen?: boolean): void
  openSpeakerView(): void
  exportPdf(): void
  exportImages(): void
  pickImage(): void
  pickMedia(): void
  promptMediaUrl(kind: 'video' | 'audio'): void
  insertCamera(): void
  insertTable(): void
  insertChart(): void
  insertElement(el: SlideElement, edit?: boolean): void
  armDraw(kind: 'line' | 'path' | 'connector' | 'free' | 'poly'): void
  toggleCommentMode(): void
  duplicateSlide(i: number): void
  deleteSlide(i: number): void
  openLayoutPicker(anchor: HTMLElement, opts?: { kind?: 'apply' }): void
  togglePanel(side: 'left' | 'right'): void
  openHelp(): void
  openAbout(): void
  openVersionHistory(): void
  copyDocJson(): void
  openReplaceJson(): void
  downloadCopy(): void
  openLongReadEditor(slideId: string): void
  zoom(dir: 1 | -1 | 0): void
  /** panel arrange kit */
  align(els: SlideElement[], edge: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'): void
  distribute(els: SlideElement[], axis: 'x' | 'y'): void
  reorder(els: SlideElement[], where: 'front' | 'back'): void
  step(els: SlideElement[], dir: 1 | -1): void
  group(els: SlideElement[]): void
  ungroup(els: SlideElement[]): void
  duplicate(els: SlideElement[]): void
  deleteEls(els: SlideElement[]): void
  /** format painter on the current selection */
  paintFormat(): boolean
  embedFont(): void
  updateReferences(): void
  insertToc(hidden: boolean): void
  toast(message: string, kind?: 'neutral' | 'success' | 'error'): void
  /** host-provided file actions (embed.ts); absent = Bento's own */
  fileActions?: FileActions
}

/** File menu entries a host can take over (Collegare: PowerPoint import/export). */
export interface FileActions {
  exportPptx?: () => void
  exportHtml?: () => void
  exportJson?: () => void
  importPptx?: () => void
  importHtml?: () => void
  importJson?: () => void
  /** false hides every import entry (e.g. students without permission) */
  canImport?: boolean
}

const RIBBON_KEY = 'bento-ribbon'
const TAB_KEY = 'bento-ribbon-tab'

export function ribbonPreferred(hostDefault: boolean): boolean {
  const v = lsGet(RIBBON_KEY)
  return v === null ? hostDefault : v === 'on'
}
export function setRibbonPreferred(on: boolean) {
  lsSet(RIBBON_KEY, on ? 'on' : 'off')
}

type Tab = 'file' | 'home' | 'insert' | 'design' | 'transitions' | 'animations' | 'show' | 'review' | 'view'
const TABS: Array<[Tab, string]> = [
  ['file', 'File'],
  ['home', 'Home'],
  ['insert', 'Insert'],
  ['design', 'Design'],
  ['transitions', 'Transitions'],
  ['animations', 'Animations'],
  ['show', 'Slide Show'],
  ['review', 'Review'],
  ['view', 'View'],
]

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}

export class Ribbon {
  readonly root: HTMLElement
  private tabsRow: HTMLElement
  private body: HTMLElement
  private tab: Tab
  /** per-tab refreshers for live state (font size of the selection, active transition …) */
  private refreshers: Array<() => void> = []
  private openMenu: HTMLElement | null = null

  constructor(private host: RibbonHost) {
    this.root = el('div', 'ed-ribbon')
    this.root.setAttribute('role', 'toolbar')
    this.root.setAttribute('aria-label', t('Ribbon'))
    this.tabsRow = el('div', 'ed-ribbon-tabs')
    this.tabsRow.setAttribute('role', 'tablist')
    this.body = el('div', 'ed-ribbon-body')
    this.root.append(this.tabsRow, this.body)
    const saved = lsGet(TAB_KEY) as Tab | null
    this.tab = saved && TABS.some(([k]) => k === saved) && saved !== 'file' ? saved : 'home'
    this.renderTabs()
    this.renderBody()
    const store = host.store
    store.on('selection', () => this.refresh())
    store.on('current', () => this.refresh())
    store.on('doc', () => this.refresh())
    document.addEventListener('pointerdown', (ev) => {
      if (this.openMenu && !this.openMenu.parentElement?.contains(ev.target as Node)) this.closeMenu()
    })
    // a text selection inside a box being edited changes bold/italic state
    document.addEventListener('selectionchange', () => {
      if (document.activeElement?.closest?.('.ed-stage-scale [contenteditable="true"]')) this.refresh()
    })
  }

  private get store() {
    return this.host.store
  }
  private get selected(): SlideElement[] {
    return this.store.selectedElements
  }
  private get texts(): TextElement[] {
    return this.selected.filter((e): e is TextElement => e.type === 'text')
  }
  /** a text box is being edited on the canvas — inline formatting applies to the selection inside it */
  private get editingText(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null
    return a && a.isContentEditable && a.closest('.ed-stage-scale') ? a : null
  }

  private renderTabs() {
    this.tabsRow.textContent = ''
    for (const [key, label] of TABS) {
      const b = el('button', 'ed-ribbon-tab' + (key === 'file' ? ' ed-ribbon-file' : ''), t(label))
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(key === this.tab))
      b.addEventListener('click', () => {
        if (key === 'file') return this.openFileMenu(b)
        this.tab = key
        lsSet(TAB_KEY, key)
        this.renderTabs()
        this.renderBody()
      })
      this.tabsRow.appendChild(b)
    }
  }

  private refresh() {
    for (const r of this.refreshers) r()
  }

  private renderBody() {
    this.body.textContent = ''
    this.refreshers = []
    const build: Record<Exclude<Tab, 'file'>, () => void> = {
      home: () => this.buildHome(),
      insert: () => this.buildInsert(),
      design: () => this.buildDesign(),
      transitions: () => this.buildTransitions(),
      animations: () => this.buildAnimations(),
      show: () => this.buildShow(),
      review: () => this.buildReview(),
      view: () => this.buildView(),
    }
    build[this.tab as Exclude<Tab, 'file'>]()
    this.refresh()
  }

  // --- building blocks -------------------------------------------------------

  private group(label: string): HTMLElement {
    const g = el('div', 'ed-rgroup')
    const content = el('div', 'ed-rgroup-content')
    g.append(content, el('div', 'ed-rgroup-label', t(label)))
    this.body.appendChild(g)
    return content
  }

  /** big button: icon above label */
  private big(into: HTMLElement, icon: string, label: string, tip: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
    const b = el('button', 'ed-rbtn ed-rbtn-big')
    b.type = 'button'
    b.innerHTML = `<span class="ed-ricon">${icon}</span><span class="ed-rlabel"></span>`
    b.querySelector('.ed-rlabel')!.textContent = t(label)
    b.title = t(tip)
    b.addEventListener('click', () => onClick(b))
    into.appendChild(b)
    return b
  }

  /** small button: icon left of label (label may be empty) */
  private small(into: HTMLElement, icon: string, label: string, tip: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
    const b = el('button', 'ed-rbtn ed-rbtn-small')
    b.type = 'button'
    b.innerHTML = `<span class="ed-ricon">${icon}</span>` + (label ? `<span class="ed-rlabel"></span>` : '')
    if (label) b.querySelector('.ed-rlabel')!.textContent = t(label)
    b.title = t(tip)
    b.setAttribute('aria-label', t(tip))
    // keep the text selection inside an edited box while clicking a format button
    b.addEventListener('mousedown', (ev) => ev.preventDefault())
    b.addEventListener('click', () => onClick(b))
    into.appendChild(b)
    return b
  }

  private stack(into: HTMLElement): HTMLElement {
    const s = el('div', 'ed-rstack')
    into.appendChild(s)
    return s
  }
  private row(into: HTMLElement): HTMLElement {
    const r = el('div', 'ed-rrow')
    into.appendChild(r)
    return r
  }

  /** dropdown menu under a button */
  private menu(anchor: HTMLElement, items: Array<[string, string, () => void] | null>) {
    this.closeMenu()
    const m = el('div', 'ed-rmenu')
    for (const it of items) {
      if (!it) {
        m.appendChild(el('div', 'ed-rmenu-sep'))
        continue
      }
      const [icon, label, fn] = it
      const b = el('button', 'ed-rmenu-item')
      b.type = 'button'
      b.innerHTML = `<span class="ed-ricon">${icon}</span><span></span>`
      b.lastElementChild!.textContent = t(label)
      b.addEventListener('click', () => {
        this.closeMenu()
        fn()
      })
      m.appendChild(b)
    }
    const r = anchor.getBoundingClientRect()
    const rr = this.root.getBoundingClientRect()
    m.style.left = `${Math.max(4, Math.min(r.left - rr.left, rr.width - 240))}px`
    m.style.top = `${r.bottom - rr.top + 2}px`
    this.root.appendChild(m)
    this.openMenu = m
  }
  private closeMenu() {
    this.openMenu?.remove()
    this.openMenu = null
  }

  /** a gallery of choices, one active (transitions, animations) */
  private gallery<T extends string>(into: HTMLElement, items: Array<[T, string, string]>, current: () => T | null, pick: (v: T) => void, enabled: () => boolean = () => true) {
    const wrap = el('div', 'ed-rgallery')
    const btns = new Map<T, HTMLButtonElement>()
    for (const [value, icon, label] of items) {
      const b = el('button', 'ed-rgal-item')
      b.type = 'button'
      b.innerHTML = `<span class="ed-rgal-icon">${icon}</span><span class="ed-rlabel"></span>`
      b.querySelector('.ed-rlabel')!.textContent = t(label)
      b.addEventListener('click', () => pick(value))
      btns.set(value, b)
      wrap.appendChild(b)
    }
    into.appendChild(wrap)
    this.refreshers.push(() => {
      const cur = current()
      const on = enabled()
      for (const [v, b] of btns) {
        b.classList.toggle('on', v === cur)
        b.disabled = !on
      }
    })
  }

  private needSelection(fn: (els: SlideElement[]) => void, min = 1) {
    return () => {
      const els = this.selected
      if (els.length < min) return this.host.toast(min > 1 ? t('Select at least {n} elements first', { n: String(min) }) : t('Select an element on the slide first'))
      fn(els)
    }
  }

  /** set a property on every selected text box (one undo step) */
  private setText(fn: (te: TextElement) => void) {
    const ids = this.texts.map((x) => x.id)
    if (!ids.length) return this.host.toast(t('Select a text box first'))
    this.store.commit(() => {
      for (const id of ids) {
        const cur = this.store.element(id)
        if (cur?.type === 'text') fn(cur)
      }
    })
  }

  /** bold/italic/underline/strike: inside an edited box on the selection, else on whole boxes */
  private inline(cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough', tag: string) {
    if (this.editingText) {
      document.execCommand(cmd)
      this.editingText.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    if (cmd === 'bold') {
      const on = this.texts.every((x) => x.fontWeight >= 600)
      return this.setText((x) => { x.fontWeight = on ? 400 : 700 })
    }
    const all = this.texts.length && this.texts.every((x) => new RegExp(`^<${tag}>[\\s\\S]*</${tag}>$`).test(x.html))
    this.setText((x) => {
      x.html = all ? x.html.replace(new RegExp(`^<${tag}>([\\s\\S]*)</${tag}>$`), '$1') : `<${tag}>${x.html}</${tag}>`
    })
  }

  // --- File (backstage-like menu) -------------------------------------------

  private openFileMenu(anchor: HTMLElement) {
    const fa = this.host.fileActions
    const canImport = fa?.canImport !== false
    const items: Array<[string, string, () => void] | null> = [
      [ICONS.save, 'Save', () => this.host.save(false)],
      null,
      [ICONS.download, 'Export as Bento file (.html)…', () => (fa?.exportHtml ? fa.exportHtml() : this.host.downloadCopy())],
      [ICONS.code, 'Export as JSON…', () => (fa?.exportJson ? fa.exportJson() : this.host.copyDocJson())],
      [ICONS.pdf, 'Export as PDF (print)…', () => this.host.exportPdf()],
      [ICONS.image, 'Export slides as images…', () => this.host.exportImages()],
    ]
    // PowerPoint conversion lives in the host (Collegare), never in this file
    if (fa?.exportPptx) items.splice(2, 0, [ICONS.download, 'Export as PowerPoint (.pptx)…', fa.exportPptx])
    if (canImport) {
      items.push(
        null,
        ...(fa?.importPptx ? [[ICONS.plus, 'Import PowerPoint (.pptx, .ppt)…', fa.importPptx] as [string, string, () => void]] : []),
        ...(fa?.importHtml ? [[ICONS.plus, 'Import Bento file (.html)…', fa.importHtml] as [string, string, () => void]] : []),
        [ICONS.code, 'Import JSON…', () => (fa?.importJson ? fa.importJson() : this.host.openReplaceJson())],
      )
    }
    items.push(null, [ICONS.history, 'Version history…', () => this.host.openVersionHistory()], [ICONS.template, 'Document properties & about…', () => this.host.openAbout()])
    this.menu(anchor, items)
  }

  // --- Home --------------------------------------------------------------------

  private buildHome() {
    const clip = this.group('Clipboard')
    this.big(clip, ICONS.brush, 'Format Painter', 'Format Painter — pick up the formatting of the selected element, then click the elements that should get it', () => {
      if (!this.host.paintFormat()) this.host.toast(t('Select a text box or shape first'))
    })
    const cs = this.stack(clip)
    this.small(cs, ICONS.copy, 'Duplicate', 'Duplicate the selection (⌘D)', this.needSelection((els) => this.host.duplicate(els)))
    this.small(cs, ICONS.trash, 'Delete', 'Delete the selection (Del)', this.needSelection((els) => this.host.deleteEls(els)))

    const slides = this.group('Slides')
    this.big(slides, ICONS.plus, 'New Slide', 'New slide from a layout', (b) => this.host.openLayoutPicker(b))
    const ss = this.stack(slides)
    this.small(ss, ICONS.template, 'Layout', 'Apply a layout to this slide', (b) => this.host.openLayoutPicker(b, { kind: 'apply' }))
    this.small(ss, ICONS.copy, 'Duplicate slide', 'Duplicate this slide', () => this.host.duplicateSlide(this.store.currentIndex))
    this.small(ss, ICONS.trash, 'Delete slide', 'Delete this slide', () => this.host.deleteSlide(this.store.currentIndex))

    // Font
    const font = this.group('Font')
    const fr = this.row(font)
    const fam = el('select', 'ed-rselect ed-rfont')
    fam.title = t('Font')
    const fillFonts = () => {
      fam.textContent = ''
      const blank = el('option', '', '—')
      blank.value = ''
      fam.appendChild(blank)
      for (const f of this.store.doc.fonts ?? []) {
        const o = el('option', '', f.family)
        o.value = f.family
        fam.appendChild(o)
      }
      for (const f of FONT_CHOICES) {
        const o = el('option', '', f.label)
        o.value = f.stack
        fam.appendChild(o)
      }
    }
    fillFonts()
    fam.addEventListener('change', () => fam.value && this.setText((x) => { x.fontFamily = fam.value }))
    const size = el('input', 'ed-rselect ed-rsize')
    size.type = 'number'
    size.min = '6'
    size.max = '400'
    size.title = t('Font size')
    size.addEventListener('change', () => {
      const v = Number(size.value)
      if (v >= 6) this.setText((x) => { x.fontSize = v })
    })
    fr.append(fam, size)
    this.small(fr, 'A<sup>+</sup>', '', 'Increase font size', () => this.setText((x) => { x.fontSize = Math.round(x.fontSize * 1.1 + 1) }))
    this.small(fr, 'A<sup>−</sup>', '', 'Decrease font size', () => this.setText((x) => { x.fontSize = Math.max(6, Math.round(x.fontSize / 1.1 - 1)) }))
    const fr2 = this.row(font)
    const bB = this.small(fr2, '<b>F</b>', '', 'Bold (⌘B)', () => this.inline('bold', 'b'))
    const iB = this.small(fr2, '<i>K</i>', '', 'Italic (⌘I)', () => this.inline('italic', 'i'))
    const uB = this.small(fr2, '<u>U</u>', '', 'Underline (⌘U)', () => this.inline('underline', 'u'))
    this.small(fr2, '<s>S</s>', '', 'Strikethrough', () => this.inline('strikeThrough', 's'))
    const color = el('input', 'ed-rcolor')
    color.type = 'color'
    color.title = t('Font color')
    color.addEventListener('input', () => {
      if (this.editingText) {
        document.execCommand('foreColor', false, color.value)
        this.editingText.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    color.addEventListener('change', () => !this.editingText && this.setText((x) => { x.color = color.value; delete x.colorGradient }))
    fr2.appendChild(color)
    this.refreshers.push(() => {
      const tx = this.texts
      const has = tx.length > 0
      fam.disabled = size.disabled = color.disabled = !has
      if (!has) return
      const f = tx[0]
      const match = [...fam.options].find((o) => o.value && (o.value === f.fontFamily || firstFamily(o.value) === firstFamily(f.fontFamily)))
      fam.value = match?.value ?? ''
      if (document.activeElement !== size) size.value = String(Math.round(f.fontSize))
      if (/^#[0-9a-f]{6}$/i.test(f.color)) color.value = f.color
      const editing = !!this.editingText
      bB.classList.toggle('on', editing ? document.queryCommandState('bold') : tx.every((x) => x.fontWeight >= 600))
      iB.classList.toggle('on', editing && document.queryCommandState('italic'))
      uB.classList.toggle('on', editing && document.queryCommandState('underline'))
    })
    this.refreshers.push(() => {
      if ((this.store.doc.fonts ?? []).length + FONT_CHOICES.length + 1 !== fam.options.length) fillFonts()
    })

    // Paragraph
    const para = this.group('Paragraph')
    const pr = this.row(para)
    const aligns: Array<[TextElement['align'], string, string]> = [
      ['left', '⯇≡', 'Align left'],
      ['center', '≡', 'Center'],
      ['right', '≡⯈', 'Align right'],
      ['justify', '☰', 'Justify'],
    ]
    const alignBtns = aligns.map(([v, icon, tip]) => [v, this.small(pr, icon, '', tip, () => this.setText((x) => { x.align = v }))] as const)
    const pr2 = this.row(para)
    this.small(pr2, '•≡', '', 'Bulleted list', () => {
      if (this.editingText) {
        document.execCommand('insertUnorderedList')
        this.editingText.dispatchEvent(new Event('input', { bubbles: true }))
      } else this.setText((x) => { x.html = x.html.split(/<br\s*\/?>/).map((l) => (/^•\s/.test(l) ? l.replace(/^•\s/, '') : '• ' + l)).join('<br>') })
    })
    const valigns: Array<[TextElement['valign'], string, string]> = [
      ['top', '⤒', 'Align text to top'],
      ['middle', '⇳', 'Align text to middle'],
      ['bottom', '⤓', 'Align text to bottom'],
    ]
    for (const [v, icon, tip] of valigns) this.small(pr2, icon, '', tip, () => this.setText((x) => { x.valign = v }))
    this.refreshers.push(() => {
      const a = this.texts[0]?.align
      for (const [v, b] of alignBtns) b.classList.toggle('on', v === a)
    })

    // Drawing
    const draw = this.group('Drawing')
    this.big(draw, ICONS.shapes, 'Shapes', 'Insert a shape', (b) => this.shapeMenu(b))
    const ds = this.stack(draw)
    this.small(ds, ICONS.front, 'Arrange', 'Order, align and group', (b) =>
      this.menu(b, [
        [ICONS.front, 'Bring to Front', this.needSelection((els) => this.host.reorder(els, 'front'))],
        [ICONS.front, 'Bring Forward', this.needSelection((els) => this.host.step(els, 1))],
        [ICONS.back, 'Send Backward', this.needSelection((els) => this.host.step(els, -1))],
        [ICONS.back, 'Send to Back', this.needSelection((els) => this.host.reorder(els, 'back'))],
        null,
        ['⇤', 'Align Left', this.needSelection((els) => this.host.align(els, 'left'))],
        ['⇹', 'Align Center', this.needSelection((els) => this.host.align(els, 'centerX'))],
        ['⇥', 'Align Right', this.needSelection((els) => this.host.align(els, 'right'))],
        ['⤒', 'Align Top', this.needSelection((els) => this.host.align(els, 'top'))],
        ['⇳', 'Align Middle', this.needSelection((els) => this.host.align(els, 'middleY'))],
        ['⤓', 'Align Bottom', this.needSelection((els) => this.host.align(els, 'bottom'))],
        ['⋯', 'Distribute Horizontally', this.needSelection((els) => this.host.distribute(els, 'x'), 3)],
        ['⋮', 'Distribute Vertically', this.needSelection((els) => this.host.distribute(els, 'y'), 3)],
        null,
        ['⛓', 'Group', this.needSelection((els) => this.host.group(els), 2)],
        ['⛓', 'Ungroup', this.needSelection((els) => this.host.ungroup(els))],
      ]),
    )
    this.small(ds, ICONS.panelRight, 'Format Pane', 'Show or hide the format pane (fill, outline, effects …)', () => this.host.togglePanel('right'))
  }

  private shapeMenu(anchor: HTMLElement) {
    const ins = (kind: Parameters<typeof defaultShape>[0]) => () => this.host.insertElement(defaultShape(kind))
    this.menu(anchor, [
      [ICONS.rect, 'Rectangle', ins('rect')],
      [ICONS.ellipse, 'Ellipse', ins('ellipse')],
      [ICONS.triangle, 'Triangle', ins('triangle')],
      [ICONS.arrow, 'Arrow', ins('arrow')],
      [ICONS.polygon, 'Polygon', () => this.host.armDraw('poly')],
      null,
      [ICONS.line, 'Line', () => this.host.armDraw('line')],
      [ICONS.curve, 'Curved line', () => this.host.armDraw('path')],
      [ICONS.connector, 'Connector', () => this.host.armDraw('connector')],
      [ICONS.freeform, 'Freeform', () => this.host.armDraw('free')],
    ])
  }

  // --- Insert ------------------------------------------------------------------

  private buildInsert() {
    const sl = this.group('Slides')
    this.big(sl, ICONS.plus, 'New Slide', 'New slide from a layout', (b) => this.host.openLayoutPicker(b))
    const tb = this.group('Tables')
    this.big(tb, ICONS.table, 'Table', 'Insert a table — edit cells inline; turn it into a live chart from the format pane', () => this.host.insertTable())
    const img = this.group('Images')
    this.big(img, ICONS.image, 'Pictures', 'Insert a picture — or paste one (⌘V)', () => this.host.pickImage())
    const il = this.group('Illustrations')
    this.big(il, ICONS.shapes, 'Shapes', 'Insert a shape', (b) => this.shapeMenu(b))
    this.big(il, ICONS.chart, 'Chart', 'Insert a chart — edit it visually or link it to a table', () => this.host.insertChart())
    const tx = this.group('Text')
    this.big(tx, ICONS.text, 'Text Box', 'Insert a text box', () =>
      this.host.insertElement(defaultText({ color: readableInk(this.store.slide.background), y: 120 + Math.random() * 200 }), true),
    )
    const ts = this.stack(tx)
    this.small(ts, ICONS.text, 'Table of contents', 'A table of contents that updates itself', () => this.host.insertToc(false))
    this.small(ts, ICONS.text, 'Slide number', 'A text box showing the slide number', () =>
      this.host.insertElement(defaultText({ html: '{{page}}', fontSize: 14, w: 120, h: 32, x: this.store.doc.size.width - 160, y: this.store.doc.size.height - 56, align: 'right', color: readableInk(this.store.slide.background) })),
    )
    const md = this.group('Media')
    this.big(md, ICONS.media, 'Video', 'Insert video or audio', (b) =>
      this.menu(b, [
        [ICONS.media, 'Video or audio file…', () => this.host.pickMedia()],
        [ICONS.media, 'Video from a link…', () => this.host.promptMediaUrl('video')],
        [ICONS.media, 'Audio from a link…', () => this.host.promptMediaUrl('audio')],
        [ICONS.media, 'Camera (live, in present mode)…', () => this.host.insertCamera()],
      ]),
    )
    const cm = this.group('Comments')
    this.big(cm, ICONS.comment, 'Comment', 'Comment (C) — click an element or a spot on the slide', () => this.host.toggleCommentMode())
  }

  // --- Design ------------------------------------------------------------------

  private buildDesign() {
    const sz = this.group('Customize')
    const sizes: Array<[string, number, number]> = [
      ['Widescreen (16:9)', 1280, 720],
      ['Standard (4:3)', 1024, 768],
      ['A4 landscape', 1123, 794],
      ['Square', 1080, 1080],
      ['Portrait (9:16)', 720, 1280],
    ]
    this.big(sz, ICONS.window, 'Slide Size', 'Change the page size — elements keep their size', (b) =>
      this.menu(b, sizes.map(([label, w, h]) => ['▭', label, () => this.store.commit(() => { this.store.doc.size = { width: w, height: h } })] as [string, string, () => void])),
    )
    const bgWrap = el('label', 'ed-rbtn ed-rbtn-big ed-rcolor-big')
    bgWrap.title = t('Background colour of this slide')
    const bg = el('input', 'ed-rcolor')
    bg.type = 'color'
    bgWrap.append(bg, el('span', 'ed-rlabel', t('Background')))
    bg.addEventListener('change', () => this.store.commit(() => { this.store.slide.background = bg.value }))
    sz.appendChild(bgWrap)
    this.small(this.stack(sz), ICONS.copy, 'Apply background to all', 'Use this slide’s background on every slide', () => {
      const b = this.store.slide.background
      this.store.commit(() => { for (const s of this.store.doc.slides) s.background = b })
    })
    this.refreshers.push(() => {
      const b = this.store.slide.background
      if (typeof b === 'string' && /^#[0-9a-f]{6}$/i.test(b)) bg.value = b
    })
    const fonts = this.group('Fonts')
    this.big(fonts, ICONS.text, 'Embed Font', 'Bundle a .woff2/.woff/.ttf/.otf into this file and use it for the selected text', () => this.host.embedFont())
    const media = this.group('Media')
    this.big(media, ICONS.image, 'Media Overview', 'Every embedded picture, video and font — largest first; shrink or remove unused files', () => {
      const first = assetEntries(this.store.doc)[0]
      if (!first) return this.host.toast(t('No embedded pictures, videos or fonts yet'))
      openMediaLightbox(this.store, first.key)
    })
  }

  // --- Transitions ---------------------------------------------------------------

  private buildTransitions() {
    const g = this.group('Transition to This Slide')
    const items: Array<[TransitionKind, string, string]> = [
      ['none', '▢', 'None'],
      ['fade', '◐', 'Fade'],
      ['slide', '⇨', 'Push'],
      ['zoom', '⤢', 'Zoom'],
      ['morph', '✦', 'Morph'],
    ]
    this.gallery(g, items, () => this.store.slide.transition ?? 'none', (v) => this.store.commit(() => { this.store.slide.transition = v }))
    const timing = this.group('Timing')
    this.big(timing, ICONS.copy, 'Apply To All', 'Use this transition on every slide', () => {
      const v = this.store.slide.transition
      this.store.commit(() => { for (const s of this.store.doc.slides) s.transition = v })
      this.host.toast(t('Transition applied to all slides'), 'success')
    })
    const m = this.group('Morph')
    this.big(m, '✦', 'Morph pairing', 'Elements with the same id morph between slides — duplicate a slide and move things, or pair elements in the format pane', () => this.host.togglePanel('right'))
  }

  // --- Animations ----------------------------------------------------------------

  private buildAnimations() {
    const g = this.group('Entrance')
    type Enter = NonNullable<NonNullable<SlideElement['fx']>['enter']> | 'none'
    const items: Array<[Enter, string, string]> = [
      ['none', '▢', 'None'],
      ['fade', '◐', 'Fade'],
      ['fade-up', '⇡', 'Float In'],
      ['fade-down', '⇣', 'Float Down'],
      ['slide-left', '⇠', 'Fly In (right)'],
      ['slide-right', '⇢', 'Fly In (left)'],
      ['slide-up', '⇑', 'Fly In (bottom)'],
      ['slide-down', '⇓', 'Fly In (top)'],
    ]
    const current = (): Enter | null => {
      const els = this.selected
      if (!els.length) return null
      return (els[0].fx?.enter ?? 'none') as Enter
    }
    this.gallery(g, items, current, (v) => {
      const ids = new Set(this.selected.map((x) => x.id))
      this.store.commit(() => {
        for (const e of this.store.slide.elements) {
          if (!ids.has(e.id)) continue
          if (v === 'none') {
            if (e.fx) delete e.fx.enter
          } else e.fx = { ...(e.fx ?? {}), enter: v }
        }
      })
    }, () => this.selected.length > 0)
    const adv = this.group('Advanced Animation')
    this.big(adv, ICONS.play, 'Animation Pane', 'Order, timing, count-ups, motion paths and hover effects — in the format pane under “Presenting”', () => this.host.togglePanel('right'))
  }

  // --- Slide Show ----------------------------------------------------------------

  private buildShow() {
    const start = this.group('Start Slide Show')
    this.big(start, ICONS.slideshow, 'From Beginning', 'Start the slide show from the first slide', () => this.host.present(true, true))
    this.big(start, ICONS.play, 'From Current Slide', 'Start the slide show from this slide', () => this.host.present(false, true))
    this.big(start, ICONS.window, 'In a Window', 'Present in this browser tab (for testing or screen sharing)', () => this.host.present(false, false))
    const mon = this.group('Monitors')
    this.big(mon, ICONS.presenter, 'Presenter View', 'Notes, timer and next slide in a separate window — open it before going fullscreen', () => this.host.openSpeakerView())
    const set = this.group('Set Up')
    const hide = this.big(set, ICONS.eye, 'Hide Slide', 'Skip this slide in the show (it stays in the deck)', () =>
      this.store.commit(() => { this.store.slide.hidden = !this.store.slide.hidden }),
    )
    this.refreshers.push(() => hide.classList.toggle('on', !!this.store.slide.hidden))
  }

  // --- Review ----------------------------------------------------------------------

  private buildReview() {
    const c = this.group('Comments')
    this.big(c, ICONS.comment, 'New Comment', 'Comment (C) — click an element or a spot on the slide', () => this.host.toggleCommentMode())
    const s = this.group('Explanations & Sources')
    this.big(s, ICONS.text, 'Explanations & Sources', 'Longer reading, sources and tasks behind this slide — readers swipe up while presenting', () => this.host.openLongReadEditor(this.store.slide.id))
    this.big(s, ICONS.history, 'Update References', 'Collect the sources of all pictures and texts on the last slide', () => this.host.updateReferences())
  }

  // --- View ------------------------------------------------------------------------

  private buildView() {
    const show = this.group('Show')
    this.big(show, ICONS.panelLeft, 'Slide List', 'Show or hide the slide list ([)', () => this.host.togglePanel('left'))
    this.big(show, ICONS.panelRight, 'Format Pane', 'Show or hide the format pane (])', () => this.host.togglePanel('right'))
    const z = this.group('Zoom')
    this.big(z, '＋', 'Zoom In', 'Zoom in (⌘+)', () => this.host.zoom(1))
    this.big(z, '−', 'Zoom Out', 'Zoom out (⌘−)', () => this.host.zoom(-1))
    this.big(z, '⤢', 'Fit to Window', 'Fit the slide to the window', () => this.host.zoom(0))
    const h = this.group('Help')
    this.big(h, '<b>?</b>', 'Shortcuts', 'Shortcuts & tips (?)', () => this.host.openHelp())
  }
}
