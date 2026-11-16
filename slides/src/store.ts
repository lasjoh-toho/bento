// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import type { BentoDoc, Slide, SlideElement } from './model'

export type StoreEvent =
  | 'doc'        // any document mutation
  | 'slides'     // slide list changed (add/remove/reorder) — sidebar rebuild
  | 'current'    // current slide switched
  | 'selection'  // selected element ids changed
  | 'dirty'      // dirty flag changed

type Listener = () => void

const MAX_UNDO = 100

/** Central state: document, current slide, selection, undo/redo, dirty flag. */
export class Store {
  doc: BentoDoc
  currentIndex = 0
  selection: string[] = []
  dirty = false
  /** editor-only: which showOnHover set the canvas previews (never saved) */
  hoverPreview: string | null = null

  private undoStack: string[] = []
  private redoStack: string[] = []
  /** when each snapshot was taken (parallel to undoStack/redoStack) — for the history list */
  private undoAt: number[] = []
  private redoAt: number[] = []
  /** entries shifted off the bottom of undoStack (MAX_UNDO) — keeps
   *  `undoBase + undoStack.length` an absolute history position */
  private undoBase = 0
  /** Embedded files deleted from doc.assets, with the history position of
   *  the edit that deleted them. Snapshots exclude assets (see checkpoint),
   *  so without this an undo past a deletion — of the file itself, or of
   *  the element removal that had made it "unused" — would restore a
   *  reference to data that is gone. */
  private assetGraveyard: Array<{ key: string; value: string; at: number }> = []
  private listeners = new Map<StoreEvent, Set<Listener>>()

  /** read-only viewer: block user edits (commit) while remote ops — which
   *  apply via the session's direct state.apply + emit, NOT commit — still
   *  flow, so a live viewer sees updates but can never author them. */
  readOnly = false

  constructor(doc: BentoDoc) {
    this.doc = doc
  }

  on(event: StoreEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return () => this.listeners.get(event)!.delete(fn)
  }

  emit(event: StoreEvent) {
    this.listeners.get(event)?.forEach((fn) => fn())
  }

  get slide(): Slide {
    return this.doc.slides[this.currentIndex]
  }

  element(id: string): SlideElement | undefined {
    return this.slide.elements.find((e) => e.id === id)
  }

  get selectedElements(): SlideElement[] {
    return this.selection
      .map((id) => this.element(id))
      .filter((e): e is SlideElement => !!e)
  }

  /**
   * Replace the whole document (AI/JSON round-trip import). Undoable —
   * ⌘Z restores the previous document wholesale.
   */
  replaceDoc(next: BentoDoc) {
    this.checkpoint()
    this.doc = next
    this.currentIndex = 0
    this.selection = []
    this.setDirty(true)
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
    this.emit('doc')
  }

  // --- history ------------------------------------------------------------

  /** Snapshot current doc state onto the undo stack. Call BEFORE a mutation.
   *  Excludes `assets` — the current assets carry over as-is on restore();
   *  the only deletions go through deleteAssets(), whose graveyard lets an
   *  undo bring the data back. Skipping them here is what keeps checkpoint() fast on decks
   *  with embedded images — JSON.stringify-ing megabytes of base64 data URIs
   *  on literally every single edit was the real cost, not anything about
   *  a particular feature. */
  checkpoint() {
    const { assets: _assets, ...rest } = this.doc
    this.undoStack.push(JSON.stringify(rest))
    this.undoAt.push(Date.now())
    if (this.undoStack.length > MAX_UNDO) { this.undoStack.shift(); this.undoAt.shift(); this.undoBase++ }
    this.redoStack.length = 0
    this.redoAt.length = 0
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  /** Undo (steps < 0) or redo (steps > 0) several edits at once — the history list jumps there. */
  step(steps: number) {
    for (let i = 0; i < Math.abs(steps); i++) {
      if (steps < 0 ? !this.canUndo : !this.canRedo) break
      if (steps < 0) this.undo()
      else this.redo()
    }
  }

  /**
   * The undo history as a list, oldest first: what each edit changed (worked out by comparing the snapshots,
   * the editor does not name its edits) and when. `undo` are the edits that can be undone (the last one is the
   * newest), `redo` those undone so far (the first one would come back next).
   */
  history(): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
    const { assets: _a, ...rest } = this.doc
    const now = JSON.stringify(rest)
    // states in order: undoStack…, now, redoStack reversed
    const states = [...this.undoStack, now, ...[...this.redoStack].reverse()]
    const at = [...this.undoAt, ...[...this.redoAt].reverse()]
    const parsed = states.map((j) => { try { return JSON.parse(j) as BentoDoc } catch { return null } })
    const entries: HistoryEntry[] = []
    for (let i = 0; i + 1 < states.length; i++) entries.push({ ...describeChange(parsed[i], parsed[i + 1]), at: at[i] ?? 0 })
    const n = this.undoStack.length
    return { undo: entries.slice(0, n), redo: entries.slice(n) }
  }

  /** Replace an embedded file's data inside an edit (e.g. a shrunk image) —
   *  like deleteAssets, ⌘Z of that edit restores the previous data. */
  replaceAsset(key: string, value: string) {
    const assets = this.doc.assets
    if (!assets || !(key in assets) || assets[key] === value) return
    this.assetGraveyard.push({ key, value: assets[key], at: this.undoBase + this.undoStack.length })
    assets[key] = value
  }

  /** Delete embedded files inside an edit — call from within commit(), after
   *  its checkpoint, so ⌘Z of that edit (or of any earlier one) brings the
   *  data back. Missing keys are ignored. */
  deleteAssets(keys: Iterable<string>) {
    const assets = this.doc.assets
    if (!assets) return
    const at = this.undoBase + this.undoStack.length
    for (const key of keys) {
      if (!(key in assets)) continue
      this.assetGraveyard.push({ key, value: assets[key], at })
      delete assets[key]
    }
  }

  /** checkpoint() + mutate + notify, in one call. */
  commit(mutate: () => void, event: StoreEvent = 'doc') {
    if (this.readOnly) return // live viewer — user edits are inert
    this.checkpoint()
    mutate()
    this.touch(event)
  }

  /** Mark dirty and notify after an in-place mutation (no checkpoint). */
  touch(event: StoreEvent = 'doc') {
    this.doc.modified = new Date().toISOString()
    this.setDirty(true)
    this.emit('doc')
    if (event !== 'doc') this.emit(event)
  }

  undo() { this.restore(this.undoStack, this.redoStack) }
  redo() { this.restore(this.redoStack, this.undoStack) }

  private restore(from: string[], to: string[]) {
    const snapshot = from.pop()
    if (!snapshot) return
    const t = (from === this.undoStack ? this.undoAt : this.redoAt).pop() ?? Date.now()
    ;(from === this.undoStack ? this.redoAt : this.undoAt).push(t)
    const { assets: _assets, ...rest } = this.doc
    to.push(JSON.stringify(rest))
    this.doc = { ...JSON.parse(snapshot), assets: this.doc.assets }
    if (from === this.undoStack && this.assetGraveyard.length) {
      const pos = this.undoBase + this.undoStack.length
      const revive = this.assetGraveyard.filter((g) => g.at > pos).reverse()
      this.assetGraveyard = this.assetGraveyard.filter((g) => g.at <= pos)
      revive.forEach((g) => {
        ;(this.doc.assets ??= {})[g.key] = g.value
      })
    }
    this.currentIndex = Math.min(this.currentIndex, this.doc.slides.length - 1)
    this.selection = this.selection.filter((id) => this.element(id))
    this.setDirty(true)
    this.emit('doc')
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
  }

  setDirty(dirty: boolean) {
    if (this.dirty === dirty) return
    this.dirty = dirty
    this.emit('dirty')
  }

  // --- navigation & selection ----------------------------------------------

  goTo(index: number) {
    const clamped = Math.max(0, Math.min(index, this.doc.slides.length - 1))
    if (clamped === this.currentIndex) return
    this.currentIndex = clamped
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  /** Step forward/back one slide, skipping interactive states (stateOf) the way
   *  linear presentation does. dir = +1 next, -1 prev. */
  goToLinear(dir: 1 | -1) {
    const slides = this.doc.slides
    for (let i = this.currentIndex + dir; i >= 0 && i < slides.length; i += dir) {
      if (!slides[i].stateOf) { this.goTo(i); return }
    }
  }

  select(ids: string[]) {
    this.selection = ids
    this.emit('selection')
  }
}

/** One entry of the undo history: what changed, on which slide, when. */
export interface HistoryEntry {
  label: string
  /** 1-based slide number the edit was on (0 = the whole deck) */
  slide: number
  at: number
}

const KIND: Record<string, [string, string]> = {
  text: ['Text box', 'Text boxes'], shape: ['Shape', 'Shapes'], image: ['Picture', 'Pictures'], svg: ['Graphic', 'Graphics'],
  chart: ['Chart', 'Charts'], table: ['Table', 'Tables'], media: ['Video', 'Videos'],
}

/** A short English description of the edit between two states (the editor translates it with t()). */
export function describeChange(a: BentoDoc | null, b: BentoDoc | null): { label: string; slide: number } {
  if (!a || !b) return { label: 'Edit', slide: 0 }
  if (a.title !== b.title) return { label: 'Renamed the deck', slide: 0 }
  if (a.slides.length < b.slides.length) {
    const i = b.slides.findIndex((s, k) => a.slides[k]?.id !== s.id)
    return { label: 'Inserted a slide', slide: (i < 0 ? b.slides.length - 1 : i) + 1 }
  }
  if (a.slides.length > b.slides.length) {
    const i = a.slides.findIndex((s, k) => b.slides[k]?.id !== s.id)
    return { label: 'Deleted a slide', slide: (i < 0 ? a.slides.length - 1 : i) + 1 }
  }
  if (a.slides.some((s, i) => s.id !== b.slides[i].id)) return { label: 'Moved a slide', slide: 0 }
  for (let i = 0; i < a.slides.length; i++) {
    const sa = a.slides[i], sb = b.slides[i]
    if (JSON.stringify(sa) === JSON.stringify(sb)) continue
    const ea = new Map(sa.elements.map((e) => [e.id, e])), eb = new Map(sb.elements.map((e) => [e.id, e]))
    const added = sb.elements.filter((e) => !ea.has(e.id)), removed = sa.elements.filter((e) => !eb.has(e.id))
    const name = (list: { type: string }[]) => {
      const k = KIND[list[0].type] ?? ['Element', 'Elements']
      return list.length > 1 && list.every((e) => e.type === list[0].type) ? k[1] : list.length > 1 ? 'Elements' : k[0]
    }
    if (added.length && removed.length) return { label: 'Replaced: ' + name(removed), slide: i + 1 }
    if (added.length) return { label: 'Inserted: ' + name(added), slide: i + 1 }
    if (removed.length) return { label: 'Deleted: ' + name(removed), slide: i + 1 }
    const changed = sb.elements.filter((e) => JSON.stringify(e) !== JSON.stringify(ea.get(e.id)))
    if (!changed.length) {
      if (sa.elements.map((e) => e.id).join() !== sb.elements.map((e) => e.id).join()) return { label: 'Changed the order', slide: i + 1 }
      if (sa.notes !== sb.notes) return { label: 'Edited the notes', slide: i + 1 }
      if (JSON.stringify(sa.background) !== JSON.stringify(sb.background)) return { label: 'Changed the background', slide: i + 1 }
      return { label: 'Changed the slide', slide: i + 1 }
    }
    const keys = new Set<string>()
    for (const e of changed) {
      const o = ea.get(e.id) as unknown as Record<string, unknown>
      const n = e as unknown as Record<string, unknown>
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) keys.add(k)
    }
    const only = (...ks: string[]) => [...keys].every((k) => ks.includes(k))
    const what = name(changed)
    if (only('x', 'y')) return { label: 'Moved: ' + what, slide: i + 1 }
    if (only('x', 'y', 'w', 'h')) return { label: 'Resized: ' + what, slide: i + 1 }
    if (only('rotation')) return { label: 'Rotated: ' + what, slide: i + 1 }
    if (keys.has('html') && changed.length === 1) return { label: 'Typed in: ' + what, slide: i + 1 }
    return { label: 'Formatted: ' + what, slide: i + 1 }
  }
  return { label: 'Changed the deck', slide: 0 }
}
