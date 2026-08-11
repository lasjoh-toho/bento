// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The larger, above-canvas editing surface for a slide's longRead (see
// model.ts's doc comment on Slide.longRead) — deliberately NOT the cramped
// properties-panel sidebar: opened from a button there (panels.ts), this
// covers the canvas area instead, one real textarea per block, each
// already styled to preview its type as you type.
//
// The actual interaction this exists for: select a passage of text within
// a block and a small floating toolbar offers every block type plus
// "Fußnote hinzufügen" — picking a type SPLITS the selection out into its
// own new block of that type (before/selection/after, with before and
// after keeping the original block's type); picking the footnote option
// prompts for the note's text and inserts an inline `[^id]` marker right
// after the selected text instead of splitting anything.

import type { Store } from '../store'
import type { LongReadBlock, Slide } from '../model'
import { uid } from '../model'
import { t } from '../i18n'

const TYPE_LABELS: Record<LongReadBlock['type'], string> = {
  heading: 'Überschrift', explain: 'Erklärtext', quote: 'Quelle/Zitat',
  caption: 'Caption', glossary: 'Glossar (Vokabel)', task: 'Arbeitsauftrag',
  references: 'Quellennachweise',
}

export class LongReadEditor {
  private overlay: HTMLElement | null = null
  private slideId = ''
  private blocksHost!: HTMLElement
  private toolbar!: HTMLElement
  private typePickerCloser: ((ev: MouseEvent) => void) | null = null
  /** Coalesces rapid keystrokes into one undo checkpoint — same pattern
   *  PropsPanel.edit() already uses for text inputs there. */
  private burst = false

  constructor(
    private host: HTMLElement,
    private store: Store,
    private onClose: () => void,
  ) {}

  get active() {
    return !!this.overlay
  }

  open(slideId: string) {
    if (this.overlay && this.slideId === slideId) return
    this.teardown()
    this.slideId = slideId
    const s = this.findSlide()
    if (!s) return
    if (!s.longRead) {
      this.store.commit(() => {
        const live = this.findSlide()
        if (live) live.longRead = { blocks: [{ id: uid('lr'), type: 'heading', text: '' }] }
      })
    }

    const overlay = document.createElement('div')
    overlay.className = 'ed-lr-overlay'

    const header = document.createElement('div')
    header.className = 'ed-lr-header'
    const title = document.createElement('span')
    title.textContent = t('Erklärung, Quellen, Arbeitsaufträge')
    const closeBtn = document.createElement('button')
    closeBtn.className = 'ed-lr-close'
    closeBtn.textContent = '✕'
    closeBtn.title = t('Schließen')
    closeBtn.addEventListener('click', () => this.close())
    const removeAllBtn = document.createElement('button')
    removeAllBtn.className = 'ed-lr-removeall'
    removeAllBtn.textContent = t('Lesetext entfernen')
    removeAllBtn.addEventListener('click', () => {
      if (!window.confirm(t('Gesamten Lesetext dieser Folie entfernen?'))) return
      this.store.commit(() => { const s = this.findSlide(); if (s) delete s.longRead })
      this.close()
    })
    const moveAllBtn = document.createElement('button')
    moveAllBtn.className = 'ed-lr-removeall'
    moveAllBtn.textContent = t('Zu anderer Folie verschieben')
    moveAllBtn.addEventListener('click', () => this.moveWholeLongReadToAnotherSlide())
    header.append(title, moveAllBtn, removeAllBtn, closeBtn)
    overlay.appendChild(header)

    const titleWrap = document.createElement('div')
    titleWrap.className = 'ed-lr-titlewrap'
    const titleCaption = document.createElement('p')
    titleCaption.className = 'ed-lr-titlecaption'
    titleCaption.textContent = t('Linktext für den Button, der diese Seite öffnet (leer = nur „^“)')
    titleWrap.appendChild(titleCaption)
    const titleInput = document.createElement('input')
    titleInput.type = 'text'
    titleInput.className = 'ed-lr-titlefield'
    titleInput.placeholder = '^'
    titleInput.value = s.longRead?.title ?? ''
    titleInput.addEventListener('input', () => {
      this.edit(() => { const live = this.findSlide(); if (live?.longRead) live.longRead.title = titleInput.value || undefined }, false)
    })
    titleInput.addEventListener('change', () => {
      this.edit(() => { const live = this.findSlide(); if (live?.longRead) live.longRead.title = titleInput.value || undefined }, true)
    })
    titleWrap.appendChild(titleInput)
    overlay.appendChild(titleWrap)

    this.blocksHost = document.createElement('div')
    this.blocksHost.className = 'ed-lr-overlay-blocks'
    overlay.appendChild(this.blocksHost)

    const addBlockBtn = document.createElement('button')
    addBlockBtn.className = 'ed-btn ed-btn-block'
    addBlockBtn.textContent = t('+ Block hinzufügen')
    addBlockBtn.addEventListener('click', () => {
      this.store.commit(() => {
        this.findSlide()?.longRead?.blocks.push({ id: uid('lr'), type: 'explain', text: '' })
      })
      this.rebuildBlocks()
    })
    overlay.appendChild(addBlockBtn)

    this.toolbar = document.createElement('div')
    this.toolbar.className = 'ed-lr-floattoolbar'
    this.toolbar.hidden = true
    overlay.appendChild(this.toolbar)

    // Pasting anywhere in the overlay that ISN'T already a block's own
    // textarea (which handles its own paste natively — typing into that
    // specific block) creates a new Erklärtext block from the pasted text,
    // rather than the paste falling through to nothing — or, before the
    // fix alongside this one (editor.ts's global paste listener), leaking
    // through to the slide canvas underneath instead.
    overlay.addEventListener('paste', (ev) => {
      if ((ev.target as HTMLElement)?.tagName === 'TEXTAREA') return // that block's own handler owns it
      const text = ev.clipboardData?.getData('text/plain')?.trim()
      if (!text) return
      ev.preventDefault()
      this.store.commit(() => {
        this.findSlide()?.longRead?.blocks.push({ id: uid('lr'), type: 'explain', text })
      })
      this.rebuildBlocks()
    })

    this.host.appendChild(overlay)
    this.overlay = overlay
    this.rebuildBlocks()
  }

  close() {
    this.teardown()
    this.onClose()
  }

  /** Moves this ENTIRE slide's Zusatztext to a different slide, per
   *  feedback that dragging every block over one at a time is tedious for
   *  a long-distance move. Target has no Zusatztext of its own yet -> the
   *  whole thing (title included) becomes its Zusatztext directly. Target
   *  already has one -> a new heading block, using the moved title (or a
   *  generic label if none was set) and marked `anchored: true`, gets
   *  appended along with every moved block right after it — the heading
   *  becomes that section's own entry point/label, exactly the same
   *  anchored-heading convention the table of contents already surfaces
   *  (see render.ts's renderTocHtml), rather than the moved content
   *  silently blending into the target's existing blocks with no way to
   *  tell where one ends and the other begins. */
  private moveWholeLongReadToAnotherSlide() {
    const slides = this.store.doc.slides
    const currentIdx = slides.findIndex((s) => s.id === this.slideId)
    if (currentIdx < 0) return
    const others = slides
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i !== currentIdx && !s.stateOf) // a state variant isn't a destination of its own, same convention renderTocHtml uses
    if (!others.length) { window.alert(t('Keine andere Folie vorhanden.')); return }
    const choice = window.prompt(
      t('Auf welche Folie verschieben? Zahl eingeben:') + '\n'
      + others.map(({ s, i }, idx) => `${idx + 1}. ` + t('Folie {n}', { n: i + 1 }) + (s.name ? ` — ${s.name}` : '')).join('\n'),
    )?.trim()
    if (!choice) return
    const pickIdx = /^\d+$/.test(choice) ? parseInt(choice, 10) - 1 : -1
    if (pickIdx < 0 || pickIdx >= others.length) return
    const targetId = others[pickIdx].s.id

    this.store.commit(() => {
      const source = this.store.doc.slides.find((s) => s.id === this.slideId)
      const target = this.store.doc.slides.find((s) => s.id === targetId)
      if (!source?.longRead || !target) return
      const moved = source.longRead
      if (!target.longRead || !target.longRead.blocks.length) {
        target.longRead = moved
      } else {
        target.longRead.blocks.push(
          { id: uid('lr'), type: 'heading', text: moved.title?.trim() || t('Verschobener Abschnitt'), anchored: true },
          ...moved.blocks,
        )
      }
      delete source.longRead
    })
    this.close()
  }

  private teardown() {
    this.overlay?.remove()
    this.overlay = null
  }

  private findSlide(): Slide | undefined {
    return this.store.doc.slides.find((s) => s.id === this.slideId)
  }

  /** Same coalescing pattern as PropsPanel.edit(): checkpoint once at the
   *  start of a burst of rapid changes (typing), then just mutate+touch
   *  until `final` closes the burst — one undo step per burst, not one
   *  per keystroke. */
  private edit(mutate: () => void, final: boolean) {
    if (!this.burst) {
      this.store.checkpoint()
      this.burst = true
    }
    mutate()
    this.store.touch()
    if (final) this.burst = false
  }

  private rebuildBlocks() {
    if (!this.overlay) return
    const s = this.findSlide()
    const blocks = s?.longRead?.blocks ?? []
    this.blocksHost.innerHTML = ''
    blocks.forEach((block, i) => this.blocksHost.appendChild(this.buildBlockRow(block, i, blocks.length)))
  }

  private buildBlockRow(block: LongReadBlock, i: number, total: number): HTMLElement {
    const row = document.createElement('div')
    row.className = `ed-lr-overlay-row ed-lr-preview-${block.type}`

    const head = document.createElement('div')
    head.className = 'ed-lr-block-head'
    const typeLabel = document.createElement('button')
    typeLabel.type = 'button'
    typeLabel.className = 'ed-lr-typelabel'
    typeLabel.textContent = TYPE_LABELS[block.type] + ' \u25be'
    typeLabel.title = t('Blocktyp ändern')
    typeLabel.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.showTypePickerFor(typeLabel, i)
    })
    head.appendChild(typeLabel)
    if (block.type === 'heading') {
      const anchorLabel = document.createElement('label')
      anchorLabel.className = 'ed-lr-anchortoggle'
      anchorLabel.title = t('Diese Überschrift als Sprungziel für einen Link verfügbar machen')
      const anchorCb = document.createElement('input')
      anchorCb.type = 'checkbox'
      anchorCb.checked = !!block.anchored
      anchorCb.addEventListener('change', () => {
        this.store.commit(() => {
          const b = this.findSlide()?.longRead?.blocks[i]
          if (b) b.anchored = anchorCb.checked || undefined
        })
      })
      anchorLabel.append(anchorCb, document.createTextNode(' ' + t('(Link)')))
      head.appendChild(anchorLabel)
    }
    const upBtn = document.createElement('button')
    upBtn.className = 'ed-lr-move'
    upBtn.textContent = '↑'
    upBtn.disabled = i === 0
    upBtn.addEventListener('click', () => {
      this.store.commit(() => {
        const bs = this.findSlide()?.longRead?.blocks
        if (bs) [bs[i - 1], bs[i]] = [bs[i], bs[i - 1]]
      })
      this.rebuildBlocks()
    })
    const downBtn = document.createElement('button')
    downBtn.className = 'ed-lr-move'
    downBtn.textContent = '↓'
    downBtn.disabled = i === total - 1
    downBtn.addEventListener('click', () => {
      this.store.commit(() => {
        const bs = this.findSlide()?.longRead?.blocks
        if (bs) [bs[i], bs[i + 1]] = [bs[i + 1], bs[i]]
      })
      this.rebuildBlocks()
    })
    const delBtn = document.createElement('button')
    delBtn.className = 'ed-lr-del'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => {
      this.store.commit(() => { this.findSlide()?.longRead?.blocks.splice(i, 1) })
      this.rebuildBlocks()
    })
    head.append(upBtn, downBtn, delBtn)
    row.appendChild(head)

    const ta = document.createElement('textarea')
    ta.className = 'ed-lr-overlay-text'
    ta.value = block.text
    ta.placeholder = TYPE_LABELS[block.type]
    ta.rows = block.type === 'heading' || block.type === 'caption' || block.type === 'glossary' ? 1 : 4
    const autoGrow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px` }
    ta.addEventListener('input', () => {
      autoGrow()
      this.commitBlockText(i, ta.value, false)
    })
    ta.addEventListener('change', () => this.commitBlockText(i, ta.value, true))
    ta.addEventListener('mouseup', () => this.maybeShowToolbar(ta, i))
    ta.addEventListener('keyup', (ev) => {
      if (ev.shiftKey || ev.key.startsWith('Arrow')) this.maybeShowToolbar(ta, i)
    })
    ta.addEventListener('blur', (ev) => {
      // Losing focus to the floating toolbar itself shouldn't hide it —
      // only actually leaving the block should.
      if (ev.relatedTarget && this.toolbar.contains(ev.relatedTarget as Node)) return
      this.toolbar.hidden = true
    })
    row.appendChild(ta)
    setTimeout(autoGrow, 0)

    if (block.type === 'quote') {
      const src = document.createElement('input')
      src.type = 'text'
      src.className = 'ed-lr-source'
      src.placeholder = t('Quelle (optional)')
      src.value = block.source ?? ''
      src.addEventListener('input', () => this.store.commit(() => {
        const b = this.findSlide()?.longRead?.blocks[i]
        if (b) b.source = src.value || undefined
      }))
      row.appendChild(src)
    }
    if (block.type === 'glossary') {
      const trans = document.createElement('input')
      trans.type = 'text'
      trans.className = 'ed-lr-source'
      trans.placeholder = t('Übersetzung oder Erklärung')
      trans.value = block.translation ?? ''
      trans.addEventListener('input', () => this.store.commit(() => {
        const b = this.findSlide()?.longRead?.blocks[i]
        if (b) b.translation = trans.value || undefined
      }))
      row.appendChild(trans)
    }
    return row
  }

  private commitBlockText(i: number, value: string, final: boolean) {
    this.edit(() => {
      const b = this.findSlide()?.longRead?.blocks[i]
      if (b) b.text = value
    }, final)
  }

  /** Shows the floating type/footnote toolbar right above the block being
   *  edited (anchored to the block, not the exact selection pixel — a
   *  plain textarea has no reliable API for the latter) whenever there's
   *  a genuine, non-empty selection in it. */
  private maybeShowToolbar(ta: HTMLTextAreaElement, blockIndex: number) {
    if (ta.selectionStart === ta.selectionEnd) { this.toolbar.hidden = true; return }
    this.buildToolbarContents(ta, blockIndex)
    this.toolbar.hidden = false // needs to be visible/laid out before measuring its own size below
    const rowRect = ta.getBoundingClientRect()
    const hostRect = this.overlay!.getBoundingClientRect()
    const toolbarRect = this.toolbar.getBoundingClientRect()
    const left = Math.max(0, Math.min(rowRect.left - hostRect.left, hostRect.width - toolbarRect.width - 4))
    // Prefer just above the block; if that would go off the TOP of the
    // overlay (a block near the very top of the reading view), flip to
    // just BELOW it instead of letting it clip off-screen.
    let top = rowRect.top - hostRect.top - toolbarRect.height - 8
    if (top < 0) top = rowRect.bottom - hostRect.top + 8
    this.toolbar.style.left = `${left}px`
    this.toolbar.style.top = `${top}px`
  }

  /** Reuses the same floating toolbar element the selection-based flow
   *  uses, just filled with ONLY the type buttons (no Referenz/Link,
   *  those need an actual text selection to attach to) and anchored to
   *  the clicked label instead of a selection rect. Clicking a type here
   *  changes the WHOLE block's type directly, no selection needed at all —
   *  the whole point of this picker existing alongside the selection-based
   *  toolbar. */
  private showTypePickerFor(anchor: HTMLElement, blockIndex: number) {
    this.toolbar.innerHTML = ''
    for (const ty of Object.keys(TYPE_LABELS) as Array<LongReadBlock['type']>) {
      const btn = document.createElement('button')
      btn.textContent = TYPE_LABELS[ty]
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        this.edit(() => {
          const b = this.findSlide()?.longRead?.blocks[blockIndex]
          if (b) b.type = ty
        }, true)
        this.toolbar.hidden = true
        this.rebuildBlocks()
      })
      this.toolbar.appendChild(btn)
    }
    this.toolbar.hidden = false
    const anchorRect = anchor.getBoundingClientRect()
    const hostRect = this.overlay!.getBoundingClientRect()
    const toolbarRect = this.toolbar.getBoundingClientRect()
    const left = Math.max(0, Math.min(anchorRect.left - hostRect.left, hostRect.width - toolbarRect.width - 4))
    let top = anchorRect.top - hostRect.top - toolbarRect.height - 8
    if (top < 0) top = anchorRect.bottom - hostRect.top + 8
    this.toolbar.style.left = `${left}px`
    this.toolbar.style.top = `${top}px`
    // A plain click anywhere else closes it — mousedown above (not click)
    // on the type buttons themselves so this document-level listener
    // firing first doesn't hide the toolbar before the button's own
    // handler gets a chance to run.
    if (this.typePickerCloser) document.removeEventListener('mousedown', this.typePickerCloser, true)
    const closeOnce = (ev: MouseEvent) => {
      if (ev.target !== anchor && !this.toolbar.contains(ev.target as Node)) {
        this.toolbar.hidden = true
        document.removeEventListener('mousedown', closeOnce, true)
        this.typePickerCloser = null
      }
    }
    this.typePickerCloser = closeOnce
    document.addEventListener('mousedown', closeOnce, true)
  }

  private buildToolbarContents(ta: HTMLTextAreaElement, blockIndex: number) {
    this.toolbar.innerHTML = ''
    for (const ty of Object.keys(TYPE_LABELS) as Array<LongReadBlock['type']>) {
      const btn = document.createElement('button')
      btn.textContent = TYPE_LABELS[ty]
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault() // keep the textarea's selection alive through the click
        this.splitSelectionIntoBlock(blockIndex, ta.selectionStart, ta.selectionEnd, ty)
      })
      this.toolbar.appendChild(btn)
    }
    const fnBtn = document.createElement('button')
    fnBtn.className = 'ed-lr-fnbtn'
    fnBtn.textContent = t('Referenz/Erklärung')
    fnBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      this.insertFootnote(blockIndex, ta.selectionStart, ta.selectionEnd)
    })
    this.toolbar.appendChild(fnBtn)
    const linkBtn = document.createElement('button')
    linkBtn.className = 'ed-lr-linkbtn'
    linkBtn.textContent = t('Link')
    linkBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      this.insertLink(blockIndex, ta.selectionStart, ta.selectionEnd)
    })
    this.toolbar.appendChild(linkBtn)
  }

  /** The core split: the selected substring becomes its own new block of
   *  `newType`; whatever sat before/after the selection in the original
   *  block stays behind (as up to two separate blocks, keeping the
   *  ORIGINAL type) rather than being dropped. */
  private splitSelectionIntoBlock(blockIndex: number, selStart: number, selEnd: number, newType: LongReadBlock['type']) {
    this.store.commit(() => {
      const blocks = this.findSlide()?.longRead?.blocks
      if (!blocks) return
      const original = blocks[blockIndex]
      const before = original.text.slice(0, selStart)
      const selected = original.text.slice(selStart, selEnd)
      const after = original.text.slice(selEnd)
      const replacement: LongReadBlock[] = []
      if (before.trim()) replacement.push({ ...original, id: original.id, text: before })
      replacement.push({ id: uid('lr'), type: newType, text: selected })
      if (after.trim()) replacement.push({ id: uid('lr'), type: original.type, text: after })
      blocks.splice(blockIndex, 1, ...replacement)
    })
    this.toolbar.hidden = true
    this.rebuildBlocks()
  }

  /** Wraps the selected text into `<<Referenz:Wort|Erklärung>>` in place
   *  (no split — a reference annotates text, it doesn't become its own
   *  block) — self-contained, no separate footnotes table to maintain. */
  private insertFootnote(blockIndex: number, selStart: number, selEnd: number) {
    const noteText = window.prompt(t('Erklärung für die markierte Stelle:'))?.trim()
    if (!noteText) { this.toolbar.hidden = true; return }
    this.store.commit(() => {
      const block = this.findSlide()?.longRead?.blocks[blockIndex]
      if (!block) return
      const selected = block.text.slice(selStart, selEnd)
      block.text = block.text.slice(0, selStart) + `<<Referenz:${selected}|${noteText}>>` + block.text.slice(selEnd)
    })
    this.toolbar.hidden = true
    this.rebuildBlocks()
  }

  /** Wraps the selected text into `<<Link:Text|URL>>` — same self-
   *  contained inline-marker convention as the reference syntax above,
   *  but rendered as an actual navigable hyperlink (present.ts) rather
   *  than a click-for-explanation bubble. */
  private insertLink(blockIndex: number, selStart: number, selEnd: number) {
    const anchored = (this.findSlide()?.longRead?.blocks ?? []).filter((b) => b.type === 'heading' && b.anchored)
    if (!anchored.length) {
      this.insertLinkWithUrl(blockIndex, selStart, selEnd, window.prompt(t('Ziel-URL für den markierten Text:'))?.trim())
      return
    }
    // At least one heading in this longRead is set up as a link target —
    // offer picking one directly (no need to know/type its internal
    // anchor id by hand) alongside the plain external-URL option.
    const choice = window.prompt(
      t('Zu welcher Überschrift springen? Zahl eingeben, oder eine externe URL:') + '\n'
      + anchored.map((b, i) => `${i + 1}. ${b.text.slice(0, 60)}`).join('\n'),
    )?.trim()
    if (!choice) { this.toolbar.hidden = true; return }
    const asIndex = /^\d+$/.test(choice) ? parseInt(choice, 10) - 1 : -1
    const url = (asIndex >= 0 && asIndex < anchored.length) ? '#lr-anchor-' + anchored[asIndex].id : choice
    this.insertLinkWithUrl(blockIndex, selStart, selEnd, url)
  }

  private insertLinkWithUrl(blockIndex: number, selStart: number, selEnd: number, url: string | undefined) {
    if (!url) { this.toolbar.hidden = true; return }
    this.store.commit(() => {
      const block = this.findSlide()?.longRead?.blocks[blockIndex]
      if (!block) return
      const selected = block.text.slice(selStart, selEnd)
      block.text = block.text.slice(0, selStart) + `<<Link:${selected}|${url}>>` + block.text.slice(selEnd)
    })
    this.toolbar.hidden = true
    this.rebuildBlocks()
  }
}
