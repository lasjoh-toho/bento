// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Direct on-canvas image cropping. The element's frame — its box on the
// slide — stays put; you reposition/zoom the PHOTO inside that fixed window,
// the same mental model every mainstream photo tool uses (Photos, Canva,
// Keynote's "Edit Mask"), rather than dragging a selection rectangle over a
// static preview. Apply/Cancel live in the properties panel (see
// panels.ts → PropsPanel.buildImageProps) — this class only owns the
// interactive geometry; panels.ts calls start()/commit()/cancel() on it via
// SlideCanvas's thin startCrop/commitCrop/cancelCrop wrappers.
//
// Working state lives in the SOURCE image's own natural pixels — not
// fractions, not slide pixels — the one reference frame that doesn't move
// while you zoom or pan. It's only converted to the doc's 0..1 fractions
// once, on commit. Aspect is always locked to the element's own box (the
// only choice that doesn't distort the image) — see model.ts's `crop` field
// doc comment for the fraction format itself.

import type { Store } from '../store'
import type { ImageElement } from '../model'
import { resolveAsset } from '../render'
import { t } from '../i18n'

type Box = { x: number; y: number; w: number; h: number } // natural image px

export class ImageCropEditor {
  private overlay: HTMLElement | null = null
  private imgNode: HTMLImageElement | null = null
  private elId = ''
  private naturalW = 0
  private naturalH = 0
  private box: Box = { x: 0, y: 0, w: 0, h: 0 }
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
   *  switching to a different one tears down and reloads. Building the
   *  overlay waits on the image's natural size (needed for the aspect math),
   *  so there's a brief gap between calling this and `active` becoming true —
   *  callers that need to know when it's ready can poll `active`, mirroring
   *  how the rest of the editor treats async image loads. */
  start(elId: string) {
    if (this.overlay && this.elId === elId) return
    this.teardown()
    const el = this.store.element(elId) as ImageElement | undefined
    if (!el || el.type !== 'image') return
    this.elId = elId
    this.dirty = false
    const probe = new Image()
    probe.onload = () => {
      if (this.elId !== elId) return // cancelled or replaced while this was loading
      this.naturalW = probe.naturalWidth || el.w
      this.naturalH = probe.naturalHeight || el.h
      const targetAR = el.w / (el.h || 1)
      const c = el.crop
      if (c && c.w > 0 && c.h > 0) {
        this.box = { x: c.x * this.naturalW, y: c.y * this.naturalH, w: c.w * this.naturalW, h: c.h * this.naturalH }
      } else {
        // Largest centred box at the required aspect — identical to what
        // `fit: cover` already shows, so entering crop mode isn't a jump.
        const imgAR = this.naturalW / this.naturalH
        if (imgAR > targetAR) { this.box.h = this.naturalH; this.box.w = this.naturalH * targetAR }
        else { this.box.w = this.naturalW; this.box.h = this.naturalW / targetAR }
        this.box.x = (this.naturalW - this.box.w) / 2
        this.box.y = (this.naturalH - this.box.h) / 2
      }
      this.buildDom(el)
    }
    probe.src = resolveAsset(this.store.doc, el.src)
  }

  /** Persist the crop and tear down. No-op (keeps the original crop
   *  byte-for-byte) if nothing was actually touched. */
  commit() {
    if (!this.overlay) return
    const id = this.elId
    const dirty = this.dirty
    const box = { ...this.box }
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
    wrap.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;overflow:visible;z-index:48`

    const imgEl = document.createElement('img')
    imgEl.className = 'ed-ce-img'
    imgEl.draggable = false
    imgEl.alt = ''
    imgEl.src = resolveAsset(this.store.doc, el.src)
    imgEl.style.cssText = 'position:absolute;max-width:none;user-select:none;pointer-events:none;display:block'
    wrap.appendChild(imgEl)

    // Fixed frame outline + the "dim everything outside" trick: a giant
    // box-shadow spread, same technique the old panel-based cropper used.
    const frame = document.createElement('div')
    frame.className = 'ed-ce-frame'
    frame.style.cssText = `position:absolute;inset:0;border:${2 * k}px solid var(--accent, #ED8266);box-shadow:0 0 0 9999px rgb(10 14 20 / 0.55);pointer-events:none`
    wrap.appendChild(frame)

    // Drag surface for panning — sits over the frame area (the part of the
    // image that's actually visible), on top of the image.
    const hit = document.createElement('div')
    hit.className = 'ed-ce-hit'
    hit.style.cssText = 'position:absolute;inset:0;cursor:move;touch-action:none'
    hit.addEventListener('mousedown', (ev) => this.dragPan(ev))
    wrap.appendChild(hit)

    // Zoom "handle": a small slider centred under the frame, counter-scaled
    // so it stays a constant physical size regardless of canvas zoom.
    const uiW = 150 / this.scale()
    const uiH = 26 / this.scale()
    const zoomWrap = document.createElement('div')
    zoomWrap.className = 'ed-ce-zoomwrap'
    zoomWrap.style.cssText =
      `position:absolute;left:${el.w / 2 - uiW / 2}px;top:${el.h + 10 / this.scale()}px;` +
      `width:${uiW}px;height:${uiH}px;transform:scale(${this.scale()});transform-origin:top left;`
    const maxW = this.naturalW
    const minW = Math.max(1, Math.min(this.naturalW, this.naturalH) * 0.15)
    const wToSlider = (w: number) => Math.round(((maxW - w) / (maxW - minW || 1)) * 1000)
    const sliderToW = (v: number) => maxW - (v / 1000) * (maxW - minW)
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.className = 'ed-ce-zoom'
    slider.min = '0'
    slider.max = '1000'
    slider.step = '1'
    slider.value = String(wToSlider(this.box.w))
    slider.title = t('Zoom')
    slider.addEventListener('mousedown', (ev) => ev.stopPropagation())
    slider.addEventListener('input', () => {
      this.zoomTo(sliderToW(+slider.value), el)
      this.dirty = true
      this.draw()
    })
    zoomWrap.appendChild(slider)
    wrap.appendChild(zoomWrap)

    this.scaleHost.appendChild(wrap)
    this.overlay = wrap
    this.imgNode = imgEl
    this.draw()
  }

  private zoomTo(newW: number, el: ImageElement) {
    const targetAR = el.w / (el.h || 1)
    const minW = Math.max(1, Math.min(this.naturalW, this.naturalH) * 0.15)
    newW = Math.max(minW, Math.min(this.naturalW, newW))
    let newH = newW / targetAR
    if (newH > this.naturalH) { newH = this.naturalH; newW = newH * targetAR }
    const cx = this.box.x + this.box.w / 2
    const cy = this.box.y + this.box.h / 2
    this.box.w = newW
    this.box.h = newH
    this.box.x = cx - newW / 2
    this.box.y = cy - newH / 2
    this.clamp()
  }

  private clamp() {
    this.box.w = Math.min(this.box.w, this.naturalW)
    this.box.h = Math.min(this.box.h, this.naturalH)
    this.box.x = Math.max(0, Math.min(this.box.x, this.naturalW - this.box.w))
    this.box.y = Math.max(0, Math.min(this.box.y, this.naturalH - this.box.h))
  }

  private draw() {
    if (!this.overlay || !this.imgNode) return
    const el = this.store.element(this.elId) as ImageElement | undefined
    if (!el) return
    const S = el.w / this.box.w // slide px per natural-image px
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
    const el = this.store.element(this.elId) as ImageElement | undefined
    if (!el) return
    const startClientX = down.clientX
    const startClientY = down.clientY
    const startBox = { ...this.box }
    const S = el.w / startBox.w // fixed for the whole gesture — matches how zoom-mid-drag is handled elsewhere in this file set
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
}
