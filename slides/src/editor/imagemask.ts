// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// On-canvas cutout/erase tools for images: magic wand, a size-adjustable
// eraser, and box/ellipse marquee-erase — plus a standalone `bakeImagePermanent`
// that flattens crop+mask into one smaller image. See model.ts's `mask` field
// doc comment for the storage format and render.ts for how it's applied.
//
// Editing itself never touches the document: a plain source-pixel canvas and
// an alpha working-canvas live only in this class, recomposited into a live
// preview after every stroke. Only on commit() is a mask asset written (via
// internAsset) — Cancel just discards the working canvases. Apply/Cancel and
// the tool controls (see panels.ts) live in the properties panel; this class
// only owns the interactive canvas geometry, mirroring how ImageCropEditor
// splits the same way for cropping.

import type { Store } from '../store'
import type { ImageElement } from '../model'
import { internAsset } from '../model'
import { resolveAsset } from '../render'

export type MaskTool = 'wand' | 'eraser' | 'box' | 'ellipse'

/** Longest working-canvas side, in px — caps flood-fill/undo-snapshot cost
 *  on very large source photos. Downscaled only for the editing buffer; the
 *  final bake (bakeImagePermanent) always re-reads the full-resolution
 *  source, so quality at rest is unaffected. */
const MAX_WORKING_DIM = 1400

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/** The natural-pixel source rect currently shown for an image element — the
 *  whole photo if uncropped, else the fraction `crop` selects. Shared by the
 *  live editor and the permanent bake so both agree on what "the cropped
 *  view" means. */
function sourceRect(el: ImageElement, naturalW: number, naturalH: number) {
  const c = el.crop
  const sx = c ? c.x * naturalW : 0
  const sy = c ? c.y * naturalH : 0
  const sw = c && c.w > 0 ? c.w * naturalW : naturalW
  const sh = c && c.h > 0 ? c.h * naturalH : naturalH
  return { sx, sy, sw, sh }
}

export class ImageMaskEditor {
  private overlay: HTMLElement | null = null
  private previewCanvas: HTMLCanvasElement | null = null
  private marqueeSvg: SVGSVGElement | null = null
  private colorCanvas: HTMLCanvasElement | null = null // offscreen: plain source pixels
  private maskCanvas: HTMLCanvasElement | null = null // offscreen: alpha working buffer
  private elId = ''
  private w = 0
  private h = 0 // working-canvas pixel dimensions
  private dirty = false
  private tool: MaskTool = 'eraser'
  private brushSize = 40 // working-canvas px
  private tolerance = 2 // 0..100
  /** Softens the mask's edge by this many px (a blur applied to the alpha
   *  channel right before baking, at commit — not per-stroke, so undo/redo
   *  during editing stays crisp and only the final result feathers). 0 =
   *  off, hard edge as before. */
  private feather = 0
  /** Grows (positive) or shrinks (negative) the mask boundary BEFORE
   *  feathering — same idea as Photoshop's Expand/Contract Selection ahead
   *  of a feather: feathering alone centres the soft transition exactly ON
   *  the original hard edge, which can leave a thin fringe of the old
   *  background bleeding into the subject, or eat into fine subject detail.
   *  Shifting the edge first moves where that transition sits: shrink to
   *  clear a background fringe, expand to protect subject detail (at the
   *  cost of a slightly wider halo of what used to be background). 0 = off,
   *  same as before. Applied via blur+threshold — a standard way to
   *  approximate morphological dilate/erode without a real distance-
   *  transform implementation. */
  private expand = 0
  private undoStack: ImageData[] = []
  private onChange: (() => void) | null = null

  constructor(
    private scaleHost: HTMLElement,
    private store: Store,
  ) {}

  get active() { return !!this.overlay }
  get elementId() { return this.elId }
  get canUndo() { return this.undoStack.length > 0 }

  /** Kept for API parity with ImageCropEditor; unused here — pointer math
   *  uses getBoundingClientRect() directly instead of a stored scale, since
   *  there's no on-canvas chrome (like the crop editor's zoom slider) that
   *  needs counter-scaling to a constant screen size. */
  setScaleGetter(_fn: () => number) { /* no-op */ }
  /** Called after any change the panel's Undo button state should reflect. */
  setOnChange(fn: () => void) { this.onChange = fn }
  setTool(tool: MaskTool) { this.tool = tool }
  setBrushSize(px: number) { this.brushSize = Math.max(4, Math.min(400, px)) }
  setTolerance(pct: number) { this.tolerance = Math.max(0, Math.min(100, pct)) }
  setFeather(px: number) { this.feather = Math.max(0, Math.min(40, px)) }
  setExpand(px: number) { this.expand = Math.max(-40, Math.min(40, px)) }

  async start(elId: string) {
    if (this.overlay && this.elId === elId) return
    this.teardown()
    const el = this.store.element(elId) as ImageElement | undefined
    if (!el || el.type !== 'image') return
    this.elId = elId
    this.dirty = false
    this.undoStack = []

    const img = await loadImage(resolveAsset(this.store.doc, el.src)).catch(() => null)
    if (!img || this.elId !== elId) return

    const { sx, sy, sw, sh } = sourceRect(el, img.naturalWidth, img.naturalHeight)
    const down = Math.min(1, MAX_WORKING_DIM / Math.max(sw, sh))
    this.w = Math.max(1, Math.round(sw * down))
    this.h = Math.max(1, Math.round(sh * down))

    this.colorCanvas = document.createElement('canvas')
    this.colorCanvas.width = this.w
    this.colorCanvas.height = this.h
    this.colorCanvas.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, this.w, this.h)

    this.maskCanvas = document.createElement('canvas')
    this.maskCanvas.width = this.w
    this.maskCanvas.height = this.h
    const mctx = this.maskCanvas.getContext('2d')!
    if (el.mask) {
      const maskImg = await loadImage(resolveAsset(this.store.doc, el.mask)).catch(() => null)
      if (maskImg && this.elId === elId) {
        mctx.drawImage(maskImg, 0, 0, this.w, this.h)
        // Stored mask is dual-encoded (R=G=B=alpha); normalise alpha from the
        // red channel so brush compositing behaves like a plain alpha buffer.
        const data = mctx.getImageData(0, 0, this.w, this.h)
        const px = data.data
        for (let i = 0; i < px.length; i += 4) px[i + 3] = px[i]
        mctx.putImageData(data, 0, 0)
      } else {
        mctx.fillStyle = '#fff'
        mctx.fillRect(0, 0, this.w, this.h)
      }
    } else {
      mctx.fillStyle = '#fff' // fully visible
      mctx.fillRect(0, 0, this.w, this.h)
    }
    if (this.elId !== elId) return // start()/cancel() raced while awaiting

    this.buildDom(el)
    this.recomposite()
  }

  undo() {
    if (!this.undoStack.length || !this.maskCanvas) return
    const snap = this.undoStack.pop()!
    this.maskCanvas.getContext('2d')!.putImageData(snap, 0, 0)
    this.dirty = true
    this.recomposite()
    this.onChange?.()
  }

  /** Persist the mask and tear down. No-op (leaves the element untouched)
   *  if nothing was actually erased. */
  commit() {
    if (!this.overlay || !this.maskCanvas) return
    const id = this.elId
    const dirty = this.dirty
    const w = this.w
    const h = this.h
    const maskCanvas = this.maskCanvas
    this.teardown()
    if (!dirty) return
    const src = maskCanvas.getContext('2d')!.getImageData(0, 0, w, h)
    const out = new ImageData(w, h)
    for (let i = 0; i < src.data.length; i += 4) {
      const a = src.data[i + 3]
      out.data[i] = a; out.data[i + 1] = a; out.data[i + 2] = a; out.data[i + 3] = a
    }
    const outCanvas = document.createElement('canvas')
    outCanvas.width = w
    outCanvas.height = h
    let crispSrc = out
    if (this.expand !== 0) {
      // Blur, then threshold — a standard way to approximate dilate
      // (expand>0: threshold LOW, so even faintly-blurred pixels beyond the
      // original edge become fully opaque, growing the mask) or erode
      // (expand<0: threshold HIGH, so any edge pixel that isn't ALREADY
      // fully opaque gets killed, shrinking the mask) without a real
      // distance-transform implementation.
      const pre = document.createElement('canvas')
      pre.width = w
      pre.height = h
      pre.getContext('2d')!.putImageData(out, 0, 0)
      const blurred = document.createElement('canvas')
      blurred.width = w
      blurred.height = h
      const bctx = blurred.getContext('2d')!
      bctx.filter = `blur(${Math.abs(this.expand)}px)`
      bctx.drawImage(pre, 0, 0)
      const blurredData = bctx.getImageData(0, 0, w, h)
      const threshold = this.expand > 0 ? 12 : 243 // 0..255
      const thresholded = new ImageData(w, h)
      for (let i = 0; i < blurredData.data.length; i += 4) {
        const a = blurredData.data[i + 3] >= threshold ? 255 : 0
        thresholded.data[i] = a; thresholded.data[i + 1] = a; thresholded.data[i + 2] = a; thresholded.data[i + 3] = a
      }
      crispSrc = thresholded
    }
    if (this.feather > 0) {
      // Draw the crisp alpha-only version through a blur filter rather than
      // blurring the raw pixels directly — canvas 2D's own `filter` does
      // exactly this in one draw, no manual box/Gaussian pass needed.
      const crisp = document.createElement('canvas')
      crisp.width = w
      crisp.height = h
      crisp.getContext('2d')!.putImageData(crispSrc, 0, 0)
      const octx = outCanvas.getContext('2d')!
      octx.filter = `blur(${this.feather}px)`
      octx.drawImage(crisp, 0, 0)
    } else {
      outCanvas.getContext('2d')!.putImageData(crispSrc, 0, 0)
    }
    const dataUrl = outCanvas.toDataURL('image/png')
    this.store.commit(() => {
      const el = this.store.element(id) as ImageElement | undefined
      if (!el || el.type !== 'image') return
      el.mask = internAsset(this.store.doc, dataUrl)
    })
  }

  /** Discard whatever was being edited and tear down. */
  cancel() {
    this.teardown()
  }

  private teardown() {
    this.overlay?.remove()
    this.overlay = null
    this.previewCanvas = null
    this.marqueeSvg = null
    this.colorCanvas = null
    this.maskCanvas = null
    this.elId = ''
    this.undoStack = []
  }

  // --- rendering -----------------------------------------------------------

  private buildDom(el: ImageElement) {
    const wrap = document.createElement('div')
    wrap.className = 'ed-maskedit'
    wrap.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;z-index:48;overflow:hidden;border-radius:${el.radius}px`

    const board = document.createElement('div')
    board.className = 'ed-me-board'
    board.style.cssText = 'position:absolute;inset:0'
    wrap.appendChild(board)

    const canvas = document.createElement('canvas')
    canvas.className = 'ed-me-canvas'
    canvas.width = this.w
    canvas.height = this.h
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair'
    canvas.addEventListener('mousedown', (ev) => this.onDown(ev))
    wrap.appendChild(canvas)

    const marquee = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    marquee.setAttribute('viewBox', `0 0 ${el.w} ${el.h}`)
    marquee.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
    wrap.appendChild(marquee)

    this.scaleHost.appendChild(wrap)
    this.overlay = wrap
    this.previewCanvas = canvas
    this.marqueeSvg = marquee
  }

  private recomposite() {
    if (!this.previewCanvas || !this.colorCanvas || !this.maskCanvas) return
    const ctx = this.previewCanvas.getContext('2d')!
    ctx.clearRect(0, 0, this.w, this.h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(this.colorCanvas, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(this.maskCanvas, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
  }

  private pushUndo() {
    if (!this.maskCanvas) return
    const snap = this.maskCanvas.getContext('2d')!.getImageData(0, 0, this.w, this.h)
    this.undoStack.push(snap)
    if (this.undoStack.length > 15) this.undoStack.shift()
  }

  // --- interaction -----------------------------------------------------------

  private toCanvasPx(ev: MouseEvent): { x: number; y: number } {
    const rect = this.previewCanvas!.getBoundingClientRect()
    return {
      x: ((ev.clientX - rect.left) / rect.width) * this.w,
      y: ((ev.clientY - rect.top) / rect.height) * this.h,
    }
  }

  private onDown(ev: MouseEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    if (this.tool === 'wand') this.doWand(ev)
    else if (this.tool === 'eraser') this.doEraseStroke(ev)
    else this.doShapeErase(ev)
  }

  private doEraseStroke(down: MouseEvent) {
    if (!this.maskCanvas) return
    this.pushUndo()
    const ctx = this.maskCanvas.getContext('2d')!
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    const stampAt = (p: { x: number; y: number }) => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, this.brushSize / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    let last = this.toCanvasPx(down)
    stampAt(last)
    this.dirty = true
    this.recomposite()
    const move = (ev: MouseEvent) => {
      const p = this.toCanvasPx(ev)
      const dist = Math.hypot(p.x - last.x, p.y - last.y)
      const steps = Math.max(1, Math.ceil(dist / Math.max(2, this.brushSize / 4)))
      for (let i = 1; i <= steps; i++) {
        stampAt({ x: last.x + (p.x - last.x) * (i / steps), y: last.y + (p.y - last.y) * (i / steps) })
      }
      last = p
      this.recomposite()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      ctx.globalCompositeOperation = 'source-over'
      this.onChange?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private doShapeErase(down: MouseEvent) {
    const el = this.store.element(this.elId) as ImageElement | undefined
    if (!el || !this.marqueeSvg) return
    const svg = this.marqueeSvg
    svg.innerHTML = ''
    const isEllipse = this.tool === 'ellipse'
    const shapeEl = document.createElementNS('http://www.w3.org/2000/svg', isEllipse ? 'ellipse' : 'rect')
    shapeEl.setAttribute('fill', 'rgb(91 141 239 / 0.25)')
    shapeEl.setAttribute('stroke', '#5b8def')
    shapeEl.setAttribute('stroke-width', '1.5')
    svg.appendChild(shapeEl)

    const start = this.toCanvasPx(down)
    const toSlide = (p: { x: number; y: number }) => ({ x: (p.x / this.w) * el.w, y: (p.y / this.h) * el.h })
    const update = (curPx: { x: number; y: number }) => {
      const a = toSlide(start)
      const b = toSlide(curPx)
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      const w = Math.abs(b.x - a.x)
      const h = Math.abs(b.y - a.y)
      if (isEllipse) {
        shapeEl.setAttribute('cx', String(x + w / 2))
        shapeEl.setAttribute('cy', String(y + h / 2))
        shapeEl.setAttribute('rx', String(w / 2))
        shapeEl.setAttribute('ry', String(h / 2))
      } else {
        shapeEl.setAttribute('x', String(x))
        shapeEl.setAttribute('y', String(y))
        shapeEl.setAttribute('width', String(w))
        shapeEl.setAttribute('height', String(h))
      }
    }
    update(start)

    let endPx = start
    const move = (ev: MouseEvent) => { endPx = this.toCanvasPx(ev); update(endPx) }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      svg.innerHTML = ''
      const x0 = Math.min(start.x, endPx.x)
      const y0 = Math.min(start.y, endPx.y)
      const w0 = Math.abs(endPx.x - start.x)
      const h0 = Math.abs(endPx.y - start.y)
      if (w0 < 2 || h0 < 2 || !this.maskCanvas) return // treat as a stray click, not a sliver erase
      this.pushUndo()
      const ctx = this.maskCanvas.getContext('2d')!
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = '#000'
      ctx.beginPath()
      if (isEllipse) ctx.ellipse(x0 + w0 / 2, y0 + h0 / 2, w0 / 2, h0 / 2, 0, 0, Math.PI * 2)
      else ctx.rect(x0, y0, w0, h0)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      this.dirty = true
      this.recomposite()
      this.onChange?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private doWand(down: MouseEvent) {
    if (!this.colorCanvas || !this.maskCanvas) return
    const p = this.toCanvasPx(down)
    const W = this.w
    const H = this.h
    const px0 = Math.max(0, Math.min(W - 1, Math.round(p.x)))
    const py0 = Math.max(0, Math.min(H - 1, Math.round(p.y)))
    const cdata = this.colorCanvas.getContext('2d')!.getImageData(0, 0, W, H).data
    const start0 = py0 * W + px0
    const r0 = cdata[start0 * 4]
    const g0 = cdata[start0 * 4 + 1]
    const b0 = cdata[start0 * 4 + 2]
    const tol2 = (this.tolerance / 100 * 441.7) ** 2 // 441.7 ≈ max possible RGB distance

    const visited = new Uint8Array(W * H)
    const selected: number[] = []
    const stack: number[] = [start0]
    visited[start0] = 1
    const tryPush = (ni: number) => {
      if (visited[ni]) return
      const ci = ni * 4
      const dr = cdata[ci] - r0
      const dg = cdata[ci + 1] - g0
      const db = cdata[ci + 2] - b0
      if (dr * dr + dg * dg + db * db <= tol2) { visited[ni] = 1; stack.push(ni) }
    }
    while (stack.length) {
      const i = stack.pop()!
      selected.push(i)
      const x = i % W
      const y = (i / W) | 0
      if (x > 0) tryPush(i - 1)
      if (x < W - 1) tryPush(i + 1)
      if (y > 0) tryPush(i - W)
      if (y < H - 1) tryPush(i + W)
    }

    this.pushUndo()
    const mctx = this.maskCanvas.getContext('2d')!
    const mdata = mctx.getImageData(0, 0, W, H)
    for (const i of selected) mdata.data[i * 4 + 3] = 0
    mctx.putImageData(mdata, 0, 0)
    this.dirty = true
    this.recomposite()
    this.onChange?.()
  }
}

/**
 * Flatten crop + mask into one final image and clear both fields — trades
 * away further non-destructive adjustment for storing one (usually much
 * smaller) asset instead of the full original plus a same-size mask. No-op
 * if neither is set. Works standalone — doesn't need mask-edit mode open.
 */
export async function bakeImagePermanent(store: Store, elId: string): Promise<void> {
  const el = store.element(elId) as ImageElement | undefined
  if (!el || el.type !== 'image') return
  if (!el.crop && !el.mask) return
  const img = await loadImage(resolveAsset(store.doc, el.src)).catch(() => null)
  if (!img) return
  const { sx, sy, sw, sh } = sourceRect(el, img.naturalWidth, img.naturalHeight)
  const w = Math.max(1, Math.round(sw))
  const h = Math.max(1, Math.round(sh))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
  if (el.mask) {
    const maskImg = await loadImage(resolveAsset(store.doc, el.mask)).catch(() => null)
    if (maskImg) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(maskImg, 0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'
    }
  }
  const dataUrl = canvas.toDataURL('image/png')
  store.commit(() => {
    const live = store.element(elId) as ImageElement | undefined
    if (!live || live.type !== 'image') return
    live.src = internAsset(store.doc, dataUrl)
    delete live.crop
    delete live.mask
  })
}
