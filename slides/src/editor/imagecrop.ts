// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Direct on-canvas image cropping. Two ways to work, same as mainstream
// photo/office tools offer both:
//  - Drag the frame's own edge/corner handles inward (PowerPoint's crop
//    tool, Keynote's mask handles) — the photo stays at its CURRENT scale
//    and position; only the visible window (and so the element's own
//    on-slide size) shrinks or grows. This is the direct "just trim the
//    edge" interaction that was missing before — pan/zoom alone couldn't
//    do this without first zooming out, cropping, then zooming back in to
//    compensate, which is what prompted this.
//  - Drag inside the frame to pan — the frame itself stays put; the PHOTO
//    moves inside that fixed window (Photos, Canva). Useful for
//    recomposing without changing the element's footprint on the slide.
//    "Zoom" isn't a separate control here: resizing the element normally
//    (crop mode closed) already scales whatever's currently cropped —
//    there's nothing a dedicated slider would do that resize handles don't
//    already cover once handles can also trim the frame directly.
// Apply/Cancel live in the properties panel (see panels.ts →
// PropsPanel.buildImageProps) — this class only owns the interactive
// geometry; panels.ts calls start()/commit()/cancel() on it via
// SlideCanvas's thin startCrop/commitCrop/cancelCrop wrappers.
//
// Two reference frames are tracked side by side, kept in sync by a fixed
// scale factor (S = frame.w / box.w) for the duration of any one gesture:
//  - `box`: the crop window in the SOURCE image's own natural pixels — the
//    one reference frame that doesn't move while you pan/zoom/resize.
//  - `frame`: the element's own on-slide position/size (slide px) — fixed
//    while panning/zooming, but IS what a handle-drag directly changes.
// Both are only converted to the doc's fields once, on commit (`box` to
// the 0..1 `crop` fractions, `frame` back to el.x/y/w/h) — see model.ts's
// `crop` field doc comment for the fraction format itself.

import type { Store } from '../store'
import type { ImageElement } from '../model'
import { resolveAsset } from '../render'

type Box = { x: number; y: number; w: number; h: number } // natural image px
type Frame = { x: number; y: number; w: number; h: number } // slide px
type HandleId = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se'

// Which edge(s) each handle moves: -1 = the frame's left/top edge (moves
// with the drag, opposite edge fixed), 1 = right/bottom edge (same idea),
// 0 = this axis is untouched by this handle.
const HANDLE_AXES: Record<HandleId, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  nw: { x: -1, y: -1 }, n: { x: 0, y: -1 }, ne: { x: 1, y: -1 },
  w: { x: -1, y: 0 }, e: { x: 1, y: 0 },
  sw: { x: -1, y: 1 }, s: { x: 0, y: 1 }, se: { x: 1, y: 1 },
}
const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
}
const MIN_FRAME_PX = 24 // slide px — a handle-drag can't shrink the frame past this

export class ImageCropEditor {
  private overlay: HTMLElement | null = null
  private imgNode: HTMLImageElement | null = null
  private elId = ''
  private naturalW = 0
  private naturalH = 0
  private box: Box = { x: 0, y: 0, w: 0, h: 0 }
  /** The element's own on-slide position/size — starts equal to el.x/y/w/h,
   *  but a handle-drag mutates this directly (that's the whole point);
   *  pan/zoom never touch it. Written back to the element at commit(). */
  private frame: Frame = { x: 0, y: 0, w: 0, h: 0 }
  private dirty = false
  private scale = () => 1

  constructor(
    private scaleHost: HTMLElement,
    private store: Store,
  ) {}

  get active() {
    return !!this.overlay
  }
  get elementId() {
    return this.elId
  }

  setScaleGetter(fn: () => number) {
    this.scale = fn
  }

  /** Enter crop mode for an image element. Idempotent for the same element;
   *  switching to a different one tears down and reloads. Returns once the
   *  overlay is actually built and showing — callers (canvas.ts) must await
   *  this before hiding the underlying element's own render, or there's a
   *  visible gap where NEITHER the original image nor this overlay is
   *  showing (this used to be a fire-and-forget call, which is exactly
   *  what caused that gap — imagemask.ts's start() already avoided it by
   *  being properly async/awaited from the start). */
  async start(elId: string): Promise<void> {
    if (this.overlay && this.elId === elId) return
    this.teardown()
    const el = this.store.element(elId) as ImageElement | undefined
    if (!el || el.type !== 'image') return
    this.elId = elId
    this.dirty = false
    this.frame = { x: el.x, y: el.y, w: el.w, h: el.h }
    const probe = new Image()
    await new Promise<void>((resolve) => {
      probe.onload = () => resolve()
      probe.onerror = () => resolve() // fails closed below (naturalW/H stay 0, buildDom still runs but draw() no-ops safely)
      probe.src = resolveAsset(this.store.doc, el.src)
    })
    if (this.elId !== elId) return // cancelled or replaced while this was loading
    this.naturalW = probe.naturalWidth || el.w
    this.naturalH = probe.naturalHeight || el.h
    const targetAR = el.w / (el.h || 1)
    const c = el.crop
    if (c && c.w > 0 && c.h > 0) {
      this.box = { x: c.x * this.naturalW, y: c.y * this.naturalH, w: c.w * this.naturalW, h: c.h * this.naturalH }
    } else {
      // Largest centred box at the required aspect — matches what `fit:
      // cover` already shows exactly (same "largest box at this aspect,
      // centred" rule cover itself uses), so entering crop isn't a jump
      // FOR that fit specifically. `contain` (letterboxed) and `fill`
      // (non-uniform stretch) have no equivalent in the crop model at all
      // — crop always uniformly fills the frame, never letterboxes or
      // distorts — so switching away from either of those to crop
      // necessarily changes what's visible; there's no view of the source
      // image that would make that transition seamless, unlike cover.
      const imgAR = this.naturalW / this.naturalH
      if (imgAR > targetAR) { this.box.h = this.naturalH; this.box.w = this.naturalH * targetAR }
      else { this.box.w = this.naturalW; this.box.h = this.naturalW / targetAR }
      this.box.x = (this.naturalW - this.box.w) / 2
      this.box.y = (this.naturalH - this.box.h) / 2
    }
    this.buildDom(el)
  }

  /** Persist the crop (and, if a handle-drag changed it, the element's own
   *  on-slide position/size) and tear down. No-op if nothing was actually
   *  touched. */
  commit() {
    if (!this.overlay) return
    const id = this.elId
    const dirty = this.dirty
    const box = { ...this.box }
    const frame = { ...this.frame }
    const naturalW = this.naturalW
    const naturalH = this.naturalH
    this.teardown()
    if (!dirty || naturalW <= 0 || naturalH <= 0) return
    this.store.commit(() => {
      const el = this.store.element(id) as ImageElement | undefined
      if (!el || el.type !== 'image') return
      el.crop = {
        x: +(box.x / naturalW).toFixed(4),
        y: +(box.y / naturalH).toFixed(4),
        w: +(box.w / naturalW).toFixed(4),
        h: +(box.h / naturalH).toFixed(4),
      }
      // Only a handle-drag ever changes these — pan/zoom leave frame
      // exactly equal to the element's starting x/y/w/h, so this is a
      // no-op (byte-for-byte) unless the frame itself was actually resized.
      el.x = Math.round(frame.x * 10) / 10
      el.y = Math.round(frame.y * 10) / 10
      el.w = Math.round(frame.w * 10) / 10
      el.h = Math.round(frame.h * 10) / 10
      // A mask's own pixels are aligned to the crop rectangle that existed
      // when it was painted (see model.ts's doc comment on `mask`) — a
      // DIFFERENT crop rectangle re-projects that same mask image onto the
      // wrong area at render time (the render-time math re-derives
      // position/size from the CURRENT crop, which no longer matches what
      // the mask was actually drawn against). Rather than show a visibly
      // shifted cutout, clear it here.
      if (el.mask) delete el.mask
    })
  }

  /** Discard whatever was being edited and tear down. */
  cancel() {
    this.teardown()
  }

  private teardown() {
    this.overlay?.remove()
    this.overlay = null
    this.imgNode = null
    this.elId = ''
  }

  // --- rendering ---------------------------------------------------------

  private buildDom(el: ImageElement) {
    const k = 1 / this.scale()

    const wrap = document.createElement('div')
    wrap.className = 'ed-cropedit'
    wrap.style.cssText = `position:absolute;overflow:visible;z-index:48`

    const imgEl = document.createElement('img')
    imgEl.className = 'ed-ce-img'
    imgEl.draggable = false
    imgEl.alt = ''
    imgEl.src = resolveAsset(this.store.doc, el.src)
    imgEl.style.cssText = 'position:absolute;max-width:none;user-select:none;pointer-events:none;display:block'
    wrap.appendChild(imgEl)

    // Frame outline + the "dim everything outside" trick: a giant
    // box-shadow spread, same technique the old panel-based cropper used.
    const frameEl = document.createElement('div')
    frameEl.className = 'ed-ce-frame'
    frameEl.style.cssText = `position:absolute;inset:0;border:${2 * k}px solid var(--accent, #ED8266);box-shadow:0 0 0 9999px rgb(10 14 20 / 0.55);pointer-events:none`
    wrap.appendChild(frameEl)

    // Drag surface for panning — sits over the frame area (the part of the
    // image that's actually visible), on top of the image, under the
    // corner/edge handles (added after, so they get first pick of clicks).
    const hit = document.createElement('div')
    hit.className = 'ed-ce-hit'
    hit.style.cssText = 'position:absolute;inset:0;cursor:move;touch-action:none'
    hit.addEventListener('mousedown', (ev) => this.dragPan(ev))
    wrap.appendChild(hit)

    // Crop handles — the actual fix this exists for: drag one inward and
    // the frame (so the element's own on-slide size) shrinks to match,
    // photo held at its current scale/position throughout, exactly the
    // PowerPoint/Keynote crop-tool feel. A HANDLE_SIZE physical px square,
    // counter-scaled like the zoom slider so it stays a constant size
    // regardless of canvas zoom.
    const HANDLE_SIZE = 10
    for (const id of Object.keys(HANDLE_AXES) as HandleId[]) {
      const ax = HANDLE_AXES[id]
      const hEl = document.createElement('div')
      hEl.className = 'ed-ce-handle'
      const hw = HANDLE_SIZE * k
      const left = ax.x === -1 ? `${-hw / 2}px` : ax.x === 1 ? `calc(100% - ${hw / 2}px)` : `calc(50% - ${hw / 2}px)`
      const top = ax.y === -1 ? `${-hw / 2}px` : ax.y === 1 ? `calc(100% - ${hw / 2}px)` : `calc(50% - ${hw / 2}px)`
      hEl.style.cssText =
        `position:absolute;left:${left};top:${top};width:${hw}px;height:${hw}px;` +
        `border-radius:${hw / 3}px;background:var(--accent, #ED8266);border:${1.5 * k}px solid #fff;` +
        `cursor:${HANDLE_CURSORS[id]};touch-action:none;z-index:1`
      hEl.addEventListener('mousedown', (ev) => this.dragHandle(id, ev))
      wrap.appendChild(hEl)
    }

    this.scaleHost.appendChild(wrap)
    this.overlay = wrap
    this.imgNode = imgEl
    this.draw()
  }

  private clamp() {
    this.box.w = Math.min(this.box.w, this.naturalW)
    this.box.h = Math.min(this.box.h, this.naturalH)
    this.box.x = Math.max(0, Math.min(this.box.x, this.naturalW - this.box.w))
    this.box.y = Math.max(0, Math.min(this.box.y, this.naturalH - this.box.h))
  }

  /** Repositions/resizes the wrap (the frame itself — only ever changes
   *  during a handle-drag) and the photo inside it (pan/zoom/handle-drag
   *  all end up here). */
  private draw() {
    if (!this.overlay || !this.imgNode) return
    this.overlay.style.left = `${this.frame.x}px`
    this.overlay.style.top = `${this.frame.y}px`
    this.overlay.style.width = `${this.frame.w}px`
    this.overlay.style.height = `${this.frame.h}px`
    const S = this.frame.w / this.box.w // slide px per natural-image px
    const imgW = this.naturalW * S
    const imgH = this.naturalH * S
    this.imgNode.style.width = `${imgW}px`
    this.imgNode.style.height = `${imgH}px`
    this.imgNode.style.left = `${-this.box.x * S}px`
    this.imgNode.style.top = `${-this.box.y * S}px`
  }

  // --- interaction ---------------------------------------------------------

  private dragPan(down: MouseEvent) {
    down.preventDefault()
    down.stopPropagation()
    const startClientX = down.clientX
    const startClientY = down.clientY
    const startBox = { ...this.box }
    const S = this.frame.w / startBox.w // fixed for the whole gesture
    const canvasScale = this.scale()
    const move = (ev: MouseEvent) => {
      const dxSlide = (ev.clientX - startClientX) / canvasScale
      const dySlide = (ev.clientY - startClientY) / canvasScale
      this.box.x = startBox.x - dxSlide / S
      this.box.y = startBox.y - dySlide / S
      this.clamp()
      this.dirty = true
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** The actual fix: drag a corner/edge handle to shrink or grow the
   *  frame directly — photo held at exactly its current scale (S fixed for
   *  the whole gesture, same convention as dragPan/zoomTo) and position;
   *  only the visible window (and the element's own on-slide footprint)
   *  changes. Natural-pixel `box` is what's actually authoritative here —
   *  `frame` is derived from it each move via the fixed S, so clamping box
   *  against the source image's edges (can't crop past the actual photo)
   *  automatically stops the frame at the right point too, instead of
   *  needing separate clamping logic for each. */
  private dragHandle(id: HandleId, down: MouseEvent) {
    down.preventDefault()
    down.stopPropagation()
    const ax = HANDLE_AXES[id]
    const startClientX = down.clientX
    const startClientY = down.clientY
    const startBox = { ...this.box }
    const startFrame = { ...this.frame }
    const S = startFrame.w / startBox.w // fixed for the whole gesture
    const canvasScale = this.scale()
    const minBoxW = MIN_FRAME_PX / S
    const minBoxH = MIN_FRAME_PX / S
    const move = (ev: MouseEvent) => {
      const dxSlide = (ev.clientX - startClientX) / canvasScale
      const dySlide = (ev.clientY - startClientY) / canvasScale
      const dxBox = dxSlide / S
      const dyBox = dySlide / S
      let { x, y, w, h } = startBox
      if (ax.x === -1) { // left edge moves — right edge anchored
        const newX = Math.max(0, Math.min(startBox.x + startBox.w - minBoxW, startBox.x + dxBox))
        w = startBox.x + startBox.w - newX
        x = newX
      } else if (ax.x === 1) { // right edge moves — left edge anchored
        w = Math.max(minBoxW, Math.min(this.naturalW - startBox.x, startBox.w + dxBox))
      }
      if (ax.y === -1) {
        const newY = Math.max(0, Math.min(startBox.y + startBox.h - minBoxH, startBox.y + dyBox))
        h = startBox.y + startBox.h - newY
        y = newY
      } else if (ax.y === 1) {
        h = Math.max(minBoxH, Math.min(this.naturalH - startBox.y, startBox.h + dyBox))
      }
      this.box = { x, y, w, h }
      // frame derives from box via the fixed S — the anchored edge(s)
      // (opposite the handle being dragged) stay exactly where they
      // started; only the dragged side's slide-position/frame size moves.
      this.frame = {
        x: ax.x === -1 ? startFrame.x + startFrame.w - w * S : startFrame.x,
        y: ax.y === -1 ? startFrame.y + startFrame.h - h * S : startFrame.y,
        w: w * S,
        h: h * S,
      }
      this.dirty = true
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
}
