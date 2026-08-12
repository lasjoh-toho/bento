// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/slides document model. This JSON is what lives inside the
// <script type="application/bento+json"> block of a .bento.html file.

export const FORMAT = 'bento/slides'
export const FORMAT_VERSION = 1

export type TransitionKind = 'none' | 'fade' | 'slide' | 'zoom' | 'morph'

export interface ElementBase {
  /** Stable per-slide identity: `data-el-id`, selection, connector/comment
   *  anchors, and the CRDT node key. Also the DEFAULT morph key — elements
   *  sharing an id across adjacent slides morph into each other (the
   *  duplicate-a-slide idiom). Never mutate it to re-pair a morph; set
   *  `morphId` instead so identity stays stable. */
  id: string
  /** Optional morph-key override. When set, this element morphs with elements
   *  whose effective morph key (`morphId ?? id`) matches — letting two
   *  independently-created elements on different slides be paired without
   *  touching either's `id`. Omitted = fall back to `id` (the common case).
   *  Must not collide with another element's effective key on the SAME slide. */
  morphId?: string
  x: number
  y: number
  w: number
  h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
  /**
   * Drop shadow(s), rendered with CSS drop-shadow so they follow the
   * element's alpha shape (rounded corners, ellipses, glyphs, image
   * cutouts). An array stacks: e.g. a dark elevation shadow plus a soft
   * white glow.
   */
  shadow?: ShadowSpec | ShadowSpec[]
  /** Gaussian blur ON this element, in px. Composed into the SAME CSS `filter`
   *  as `shadow` (both apply). Survives PDF/print, unlike backdrop blur. */
  blur?: number
  /** CSS mix-blend-mode for this element ('screen' for neon light glows,
   *  'multiply'/'overlay' for editorial duotones). Omitted/'' = normal. */
  blend?: string
  /** Frosted-glass backdrop blur behind this element, in px (0/undefined = off).
   *  Screen-only: browser print/PDF drops backdrop-filter (pair with a
   *  translucent `fill` so PDFs show a graceful flat panel). */
  backdropFilter?: number
  /** presentation effects, run in present mode only */
  fx?: {
    /** entrance animation when the slide is shown. fade-* nudge ~16px; slide-*
     *  sweep ~120px in from an edge (slide-left starts to the right, etc.) */
    enter?: 'fade-up' | 'fade' | 'fade-down' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
    /** entrance duration in seconds; omitted = the per-kind default
     *  (slide-* 0.75s, fade-* 0.55s). Lower = snappier, higher = more languid. */
    enterDur?: number
    /** stagger step within the entrance sequence; equal values enter together */
    order?: number
    /** animate numeric parts of the text from `countFrom` (default 0,
     *  negative allowed — counts up toward zero or down from it) to their
     *  final value written in the text itself. */
    countUp?: boolean
    /** starting value for countUp — omitted means 0. Negative counts up
     *  toward the target from below zero; a value ABOVE the target counts
     *  down instead (the animation always runs start→target, whichever
     *  direction that implies). */
    countFrom?: number
    /** how long the count-up animation itself takes, in seconds —
     *  omitted means the default (1.15s). Lower = snappier, higher =
     *  more languid, same convention as enterDur. */
    countDuration?: number
    /** continuous ambient motion (slow zoom, for full-bleed photos) */
    ambient?: 'kenburns'
    /**
     * Ken-burns tuning. dir 'drift' (default) is the endless slow yoyo zoom;
     * 'out' and 'in' play ONCE per slide entry — 'out' starts zoomed by
     * `scale` and settles to rest (the classic title-photo effect).
     * `scale` is the far end of the zoom (e.g. 1.06), `duration` in seconds.
     */
    ken?: { dir?: 'drift' | 'out' | 'in'; scale?: number; duration?: number }
    /** continuous looping animation */
    loop?:
      | { type: 'dash-march'; distance?: number; duration?: number }
      | {
          type: 'motion-path'
          path: string
          duration: number
          delay?: number
          /** easing over each lap (default 'none' = constant tempo) */
          ease?: string
          /** per-anchor speed multipliers (1 = normal, <1 dwells, >1 rushes);
           *  length matches the path's anchor count. Warps the arc-length map
           *  so the element can linger at some points and rush between others. */
          speeds?: number[]
        }
  }
  /** while presenting, clicking this element jumps to the slide with this id */
  link?: string
  /** semantic group tag — hover focus and multi-element behaviours target it */
  group?: string
  /**
   * Editor grouping: elements sharing a groupId select and move as one
   * (click any member → whole group; Alt-click digs to the individual).
   * Distinct from `group`, which carries presentation semantics.
   */
  groupId?: string
  /**
   * In-slide hover reveal: this element is only visible while an element
   * whose `group` equals this value is hovered (slide.hover type 'reveal').
   * The slide's hover.default set is shown when nothing is hovered.
   */
  showOnHover?: string
  /**
   * Layout role — what this element IS on the slide ('title', 'subtitle',
   * 'body', 'kicker'). Applying a different layout moves content between
   * same-role elements, PowerPoint-placeholder style. Free-form string;
   * those four are the conventions the built-in layouts use.
   */
  role?: string
}

export interface ShadowSpec {
  x?: number
  y?: number
  blur: number
  color: string
}

export interface TextElement extends ElementBase {
  type: 'text'
  /** Rich text as sanitized inline HTML (b/i/u/br/span only). */
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  /** When set (and stops non-empty), painted into the glyphs; wins over `color`. */
  colorGradient?: GradientFill
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  /** px; optional tracking for letter-spaced caps labels */
  letterSpacing?: number
  /** Outline / hollow glyphs via -webkit-text-stroke. `fill:'none'` makes the
   *  interior transparent (the classic hollow section-break word); default keeps
   *  the solid `color` fill and just adds an outline. */
  textStroke?: { width: number; color: string; fill?: string }
  /**
   * Layout placeholder prompt ("Click to add title"). While the element's
   * html is empty: the editor shows this dimmed; present and print hide the
   * element entirely. Cleared content brings the prompt back.
   */
  placeholder?: string
  /**
   * Dynamic table of contents — when truthy, `html` is ignored entirely at
   * render time (editor preview AND present mode): the content is instead
   * computed fresh from the CURRENT doc.slides every time, one entry per
   * slide that has a discoverable title (Slide.name if set, else the
   * slide's own largest text element — a slide with neither is skipped,
   * not shown with a placeholder). Every entry is a clickable link to
   * that slide, same [data-link] convention as an authored element link.
   * Stays current automatically as slides are added/renamed/reordered/
   * removed — never needs manual regeneration.
   *
   * `toc: 0` specifically marks the slide this element sits on as a
   * hidden "before slide 1" table-of-contents page: automatically
   * excluded from normal Next/Prev stepping and the slide count (same
   * treatment Slide.hidden already gets — no need to ALSO set that
   * separately), but reachable two ways present.ts wires up on its own:
   * pressing Prev/swiping right while already on the first normal slide
   * (rather than being a no-op there, as it otherwise would be), and a
   * small always-present hotspot at the top-center of every other slide.
   * Any other number (or `true`) behaves exactly like the plain boolean
   * always did — a completely normal slide in the linear flow that just
   * happens to hold a table of contents.
   */
  toc?: boolean | number
  /**
   * Turns this text element into a single clickable link chip targeting
   * one specific anchored heading (see LongReadBlock.anchored) — freely
   * positioned/resized like any other element, unlike a toc:true element
   * (which computes an entry for EVERY anchored heading across the whole
   * deck). `html` is ignored entirely at render time while this is set —
   * same convention toc uses — and always shows the target heading's OWN
   * current text, so it can never drift out of sync with a heading that
   * gets renamed later. Renders using the exact same [data-link]/
   * [data-link-anchor] convention renderTocHtml's own sub-entries use, so
   * present.ts's existing click-to-navigate-and-scroll handling picks it
   * up for free — nothing anchorLink-specific needed there at all.
   */
  anchorLink?: { slideId: string; blockId: string }
  /**
   * Source-citation metadata for a text element — same shared shape and
   * conventions as ImageElement.citation (see that type's own doc
   * comment). A quoted passage or a paraphrased claim can carry its own
   * attribution/reference this way, the same as a sourced image can.
   */
  citation?: Citation
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'

/** Linear gradient fill. Colors are any CSS color, including rgba(). */
export interface GradientFill {
  /** degrees, CSS convention: 0 = bottom→top, 90 = left→right */
  angle: number
  /** ordered stops; `at` is 0..1 along the gradient line */
  stops: Array<{ at: number; color: string }>
}

/** Decoration at a line's tip. Sized relative to the stroke width. */
export type LineEnding = 'none' | 'arrow' | 'dot' | 'bar'

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: ShapeKind
  fill: string
  /** when set, wins over `fill` (which is kept as the solid fallback) */
  fillGradient?: GradientFill
  stroke: string
  strokeWidth: number
  /** corner radius, rect only */
  radius: number
  /** dash length in px; 0/undefined = solid stroke (legacy — see strokeStyle) */
  strokeDash?: number
  /** stroke pattern; wins over strokeDash when set */
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  /** line shape only: tip decorations */
  lineStart?: LineEnding
  lineEnd?: LineEnding
  /** path only: SVG path data in the coordinate space given by pathBox */
  d?: string
  /** path only: [x, y, w, h] viewBox the path was authored in */
  pathBox?: [number, number, number, number]
  /**
   * Connector anchoring (line/path only): the start (`from`) and/or end (`to`)
   * of the shape follow another element. The geometry is DERIVED — the editor's
   * syncConnectors() recomputes the endpoint on that element's border toward the
   * other end whenever anything moves. A dangling ref (element deleted) is
   * dropped and the endpoint becomes free.
   */
  from?: ConnectorEnd
  to?: ConnectorEnd
}

/** One anchored end of a connector. `side:'auto'` picks the nearest border. */
export interface ConnectorEnd {
  el: string
  side?: 'auto' | 'top' | 'right' | 'bottom' | 'left'
}

export interface ImageElement extends ElementBase {
  type: 'image'
  /** data: URI, or "asset:<key>" referencing doc.assets */
  src: string
  fit: 'contain' | 'cover' | 'fill'
  radius: number
  /**
   * Optional crop rectangle, in fractions (0..1) of the SOURCE image's own
   * width/height — not the element box. {x:0,y:0,w:1,h:1} (or omitted) means
   * uncropped. When set, the cropped region is stretched to exactly fill the
   * element box (crop wins over `fit`, which is ignored while a crop is set —
   * re-enable it by clearing the crop). Authored by dragging handles in the
   * editor's crop mode (double-click an image, or the "Crop…" button in its
   * properties panel); agents can set it directly as plain fractions.
   */
  crop?: { x: number; y: number; w: number; h: number }
  /**
   * Optional cutout/erase mask — a grayscale PNG (white=visible,
   * black=erased) at the same pixel dimensions as the current CROPPED view,
   * dual-encoded (RGB *and* alpha both carry the same visibility value) so
   * it renders identically whether a browser's default `mask-image` mode is
   * luminance or alpha — no `mask-mode` needed. Applied at render using the
   * SAME size/position transform as `crop`, so it stays aligned to whatever
   * portion of the source is currently shown; changing `crop` after a mask
   * exists misaligns it (the editor clears the mask automatically when that
   * happens). Authored with the "Freistellen…" tools (magic wand, eraser,
   * box/ellipse) in the properties panel. "Make permanent" there bakes the
   * mask into `src` as one flattened image and clears this field — do that
   * once no further mask edits are needed, to stop storing the mask as a
   * second same-size asset. "asset:<key>" or a data: URI, same convention
   * as `src`.
   */
  mask?: string
  /**
   * Source-citation metadata — set automatically when an image comes
   * through a proxy fetch (bentopaste.js's paste-and-split flow), editable
   * afterward in the properties panel, or added by hand for any image.
   * See the shared `Citation` type's own doc comment for what each field
   * does and how it's used (on-slide caption vs. references list).
   */
  citation?: Citation
}

/**
 * Shared source-citation shape — used by both ImageElement and
 * TextElement.citation. `author`/`publishedYear`/`publishedPlace` render
 * as a small caption directly under the element ON the slide (when
 * `showCaption` isn't explicitly false) — visible to whoever's viewing the
 * presentation, matching a "who made this, where/when was it first
 * published" citation norm. `sourceUrl`/`retrievedAt` stay technical and
 * are never shown on the slide itself; they're only ever aggregated into a
 * References ("Quellennachweise") longRead block instead (when
 * `collectInReferences` isn't explicitly false) — see the
 * "Quellenverzeichnis aktualisieren" button in the slide panel.
 */
export interface Citation {
  /** Shown in the on-slide caption. Empty/undefined shows nothing there. */
  author?: string
  /** "Erstveröffentlichung" — year first published, if known. */
  publishedYear?: string
  /** "Erstveröffentlichung" — place/publication first published in, if known. */
  publishedPlace?: string
  /** The element's own source URL, if it came from a traceable fetch —
   *  never shown on the slide, only in the aggregated references list. */
  sourceUrl: string
  /** ISO date (YYYY-MM-DD) the source was actually retrieved — never
   *  shown on the slide, only in the aggregated references list. */
  retrievedAt: string
  /** Show the author/publication caption under the element on the slide.
   *  Undefined means true (on by default) — an explicit false is what
   *  turns it off, so older documents without this field keep behaving
   *  exactly as before it existed. */
  showCaption?: boolean
  /** Include this element's sourceUrl/retrievedAt when "Quellenverzeichnis
   *  aktualisieren" collects references. Undefined means true, same
   *  default-on convention as showCaption. */
  collectInReferences?: boolean
}

export interface SvgElement extends ElementBase {
  type: 'svg'
  /** key into doc.assets holding raw SVG markup (preferred: dedupes) */
  asset?: string
  /** raw inline SVG markup, used when asset is unset */
  markup?: string
  /**
   * CSS injected inside the svg — hover states, focus dims, and animations
   * live here and stay self-contained (svg <style> scopes to its svg).
   */
  css?: string
}

/**
 * Data chart rendered by ECharts. `option` is a PURE-JSON ECharts option
 * (template-string formatters only — never functions): static SVG snapshots
 * on the editor canvas/thumbnails/print, a live interactive instance
 * (tooltips, dataZoom) while presenting.
 */
export interface ChartElement extends ElementBase {
  type: 'chart'
  /** preset key the panel offers to re-seed from (bar/line/pie/scatter) */
  preset?: string
  option: Record<string, unknown>
  /** live data binding: xAxis labels + series values track this table element */
  source?: { tableId: string }
}

/** One cell of a table. `html` is the same sanitized inline subset as text. */
export interface TableCell {
  html: string
  align?: 'left' | 'center' | 'right'
  /** per-cell overrides (default from the table's style) */
  color?: string
  bg?: string
  bold?: boolean
}

export interface TableRow {
  cells: TableCell[]
}

/** Table-wide look. Cohesion lives here; cells carry only overrides. */
export interface TableStyle {
  headerBg: string
  headerColor: string
  /** stripe colour for alternate body rows; absent = no zebra */
  zebra?: string
  borderColor: string
  borderWidth: number
  cellPadX: number
  cellPadY: number
  fontSize: number
  fontFamily?: string
  /** default body-cell text colour */
  color: string
  /** outer corner radius (px) */
  radius: number
}

/**
 * A data table rendered as a real HTML <table> (table-layout: fixed) by the
 * shared renderer — identical on the editor canvas, thumbnails, present and
 * print. Column widths are fractional weights, normalised at render. Morphs
 * as a box (position/size + style colours); cell CONTENT does not morph.
 */
export interface TableElement extends ElementBase {
  type: 'table'
  /** fractional column weights; length = column count */
  columns: Array<{ w: number }>
  rows: TableRow[]
  /** treat row 0 as a styled header row */
  header: boolean
  style: TableStyle
}

/**
 * Audio or video. Hybrid storage: `src` is a data: URI (embedded — travels
 * inside the .bento.html), an external URL / relative path (referenced — keeps
 * the file small but needs the network / a sibling file), or "asset:<key>".
 * The editor embeds small clips and warns above MEDIA_EMBED_BUDGET, offering a
 * URL instead. Autoplay only fires in PRESENT mode (never on the canvas or in
 * thumbnails).
 */
export interface MediaElement extends ElementBase {
  type: 'media'
  /** 'camera' is a LIVE getUserMedia() stream, not a stored file — no
   *  `src` at all, requested fresh in present mode only (never in the
   *  editor canvas, which shows a placeholder instead — no reason to
   *  prompt for camera access on every edit-session page load). Free
   *  positioning/resizing/rotation and cross-slide morphing come for
   *  free from the same shared element-transform system every other
   *  element type already uses — nothing camera-specific needed there. */
  kind: 'video' | 'audio' | 'camera'
  src: string
  /** video only: a still shown before playback (data:/asset:/URL) */
  poster?: string
  /** video only: fit within the element box */
  fit?: 'contain' | 'cover' | 'fill'
  radius?: number
  /** camera only: clips the live view to a shape via CSS clip-path —
   *  cheap (no per-frame processing cost, unlike chromaKey) and composes
   *  naturally with it: a round bubble with the background ALSO removed
   *  is a common streaming look. 'circle' becomes an ellipse if the
   *  element's own box isn't square — expected, not a bug. Omitted/
   *  'none' means a plain rectangle (using `radius` for rounded corners,
   *  same as any other media element). */
  maskShape?: 'none' | 'circle'
  autoplay?: boolean
  loop?: boolean
  muted?: boolean
  controls?: boolean
  /** camera only: which physical camera to prefer, when the device has
   *  more than one — 'user' (front/selfie) or 'environment' (rear).
   *  Omitted lets the browser pick its own default. */
  facing?: 'user' | 'environment'
  /**
   * camera only: turns on green/blue-screen removal for THIS element,
   * using the ONE shared BentoDoc.cameraCalibration (see that field's own
   * doc comment) — never a per-element color/tolerance. A presentation
   * only has one physical camera+backdrop setup at a time, calibrated
   * once right before recording; every camera element in the deck that
   * turns this on shares that exact same removal, regardless of how each
   * one is individually zoomed/positioned within its own box.
   */
  chromaKeyEnabled?: boolean
  /** camera only: 1 = the raw calibrated frame shown as-is (same as
   *  `fit` alone would give); higher zooms into the CENTER of that frame
   *  before the box's own fit/crop applies — a simple way to reframe
   *  without needing a full interactive crop tool, since the shared mask
   *  itself must stay in the camera's own raw coordinate space (not
   *  something each element could crop independently without breaking
   *  alignment). Applied via CSS transform: scale(), cheap, no per-frame
   *  cost of its own. */
  zoom?: number
  /** camera only: pans the zoomed view — fractions of the element's own
   *  box (-0.5..0.5 each), same convention as a percentage offset.
   *  Meaningless at zoom 1 (nothing to pan within). */
  panX?: number
  panY?: number
}

export type SlideElement =
  | TextElement | ShapeElement | ImageElement | SvgElement | ChartElement | TableElement | MediaElement

/**
 * A review comment thread. Editor-only metadata: never rendered while
 * presenting or printing, but saved in the file so it travels with the
 * document when people pass it around.
 */
export interface Comment {
  id: string
  /** element the thread is anchored to; absent (or dangling) = the slide */
  elementId?: string
  /** point anchor in slide coordinates — used when no elementId is set */
  x?: number
  y?: number
  author: string
  text: string
  /** ISO datetime */
  at: string
  resolved?: boolean
  replies?: Array<{ id: string; author: string; text: string; at: string }>
}

export interface Slide {
  id: string
  background: string
  transition: TransitionKind
  elements: SlideElement[]
  notes: string
  /** optional friendly name (link pickers, state badges) */
  name?: string
  /**
   * Interactive state: this slide is a variant of the slide with the given
   * id. It is hidden from linear navigation — reachable only via element
   * links (and morphs smoothly when element ids are shared with its parent).
   * While on a state: ArrowLeft returns to the parent, ArrowRight continues
   * after the parent.
   */
  stateOf?: string
  /**
   * Presenter's own equivalent of PowerPoint's "Hide Slide" — skipped by
   * next/prev, the slide count, and the presenter grid in present mode
   * (same treatment as a stateOf slide gets there), but stays fully
   * editable and visible in the sidebar (dimmed, with an indicator) rather
   * than actually being removed from the deck.
   */
  hidden?: boolean
  /**
   * Optional longer-form companion reading for this slide — reached via a
   * swipe-up (or ArrowUp / an on-screen chevron on desktop) during Present
   * mode, NOT part of the fixed slide canvas: rendered as ordinary flowing
   * text in its own reading view, so it can reflow to any screen shape,
   * including a phone held in portrait, instead of being squeezed into
   * whatever the deck's fixed aspect ratio happens to be.
   *
   * Deliberately isolated as a single, self-contained module: nothing
   * else in the app reads or requires this field, so a deck without it
   * behaves exactly as if it didn't exist (fully backward compatible),
   * and the whole feature — this field, its editing UI, and the Present-
   * mode swipe/reading view — could be deleted again later without
   * touching anything else; any leftover `longRead` data in an existing
   * file would simply stop being read, never causing an error.
   */
  longRead?: {
    /** Short, readable label for the trigger button (editor toolbar, next
     *  to Slideshow — and present mode's own hint) — falls back to a
     *  plain '^' when unset, per how it's actually surfaced there. */
    title?: string
    blocks: LongReadBlock[]
  }
  /**
   * present-mode hover behaviour:
   * - focus-group: dim every element outside the hovered element's group
   * - reveal: show the showOnHover set matching the hovered group
   *   (`default` names the set visible when nothing is hovered)
   */
  hover?: { type: 'focus-group' | 'reveal'; dim?: number; default?: string }
  /** review comment threads (editor-only; see Comment) */
  comments?: Comment[]
  /**
   * Allow the on-screen pen/stylus annotation toggle in Present mode on
   * this slide — off by default (undefined = not allowed), an explicit
   * per-slide opt-in rather than a global switch, since not every slide
   * wants to invite stray marks (e.g. a quiz). Strokes drawn during Present
   * are session-only "chalk" — never written to the document, cleared the
   * moment Present mode ends or the deck is reloaded. See present.ts.
   */
  annotate?: boolean
  /** When set, wins over `background` (kept as the solid fallback) — same
   *  convention as ShapeElement.fillGradient. */
  backgroundGradient?: GradientFill
  /**
   * Persisted Present-mode annotations — term labels AND freehand pen
   * strokes both work the same way now: session-local by default (typed/
   * drawn live during Present, gated behind the `annotate` toggle above),
   * surviving Escape + restarting the presentation within the same editor
   * session because they live directly here rather than in a separate
   * draft copy — but an explicit "save" action in that toolbar marks
   * whichever of these changed as a real, dirty-flagged edit (Store.touch(),
   * since the mutation already happened in place — see present.ts), same as
   * any other change in the app. It does NOT itself write the file — that
   * still happens whenever the user does a normal save afterward. Reopening
   * the deck without ever using that action (or without a normal save
   * afterward) resets to whatever was last actually saved to the file (or
   * empty, if nothing ever was).
   *
   * Deliberately minimal for now (an annotation tool, not a quiz tool yet) —
   * but dragTerms is shaped so a later "correct drop zone" feature could add
   * an optional field per term without a redesign: id/text/position(/style)
   * only.
   */
  dragTerms?: DragTerm[]
  /** Freehand pen/eraser strokes, persisted the same way dragTerms are —
   *  see the comment above. */
  inkStrokes?: PresentInkStroke[]
}

/** One block within a slide's longRead (see Slide.longRead) — plain text,
 *  no nested formatting; the reading view styles each purely by `type`. */
export interface LongReadBlock {
  id: string
  type: 'heading' | 'explain' | 'quote' | 'caption' | 'glossary' | 'task' | 'references'
  /** The block's main text — for 'glossary' specifically, this is the
   *  vocabulary term/word itself (see `translation` for its counterpart);
   *  for 'references', one citation per line (a bibliography/further-
   *  reading list, distinct from a single quote's own `source` line).
   *  May contain inline explanatory references using
   *  `<<Referenz:Hervorgehobenes Wort|Erklärung...>>` — the highlighted
   *  word/phrase renders inline (not a footnote number), and the
   *  explanation shows in a small bubble on click; every reference found
   *  anywhere in the longRead is also collected again as a numbered list
   *  at the end of the reading view. Self-contained (no separate lookup
   *  table): the explanation lives right in the marker itself. */
  text: string
  /** Attribution/source line — only meaningful for type 'quote'. */
  source?: string
  /** The term's translation OR explanation — only meaningful for type
   *  'glossary'. Same field serves both a language-learning vocabulary
   *  list (term + translation) and a plain glossary of terminology
   *  (term + explanation); which one it is is just how it's written. */
  translation?: string
  /** Only meaningful for type 'heading' — makes this heading a valid link
   *  TARGET: gets a stable id in the rendered reading view (present.ts),
   *  and can then be jumped to from a <<Link:Text|#anchor>> reference
   *  anywhere else in this same longRead (scrolls smoothly within the
   *  reading view rather than navigating the page, since the reading
   *  view is its own scrollable overlay). Off by default — every heading
   *  becoming a jump target whether anyone actually links to it or not
   *  would be pure clutter in the block editor. */
  anchored?: boolean
}

/** One draggable term-label placed on a slide in Present mode — see
 *  Slide.dragTerms. x/y are fractions (0..1) of the viewport, same
 *  resize-independent convention as present.ts's ink marks.
 *  `style` picks how it renders: 'chip' (a pill/bubble background, the
 *  original look) or 'plain' (just colored text, no background — using
 *  `color`). Defaults to 'plain' if omitted. */
export interface DragTerm {
  id: string
  text: string
  x: number
  y: number
  style?: 'chip' | 'plain'
  color?: string
}

/** One freehand pen/eraser stroke in Present mode — see Slide.inkStrokes.
 *  Point coordinates and `width` are fractions of the viewport, same
 *  resize-independent convention as DragTerm's x/y. */
export interface PresentInkStroke {
  id: string
  points: Array<{ x: number; y: number }>
  color: string
  width: number
  erase: boolean
}

export interface BentoDoc {
  format: typeof FORMAT
  version: number
  /**
   * Stable per-document identity (uuid), minted at creation and preserved
   * for the document's whole life — the rendezvous key for future
   * sync / share / merge features. Never derived from content.
   */
  docId: string
  title: string
  /**
   * Optional document properties for template fields ({{author}}, {{company}},
   * {{subject}}, {{event}}) and general provenance. All optional → old files
   * simply lack it and every token resolves to empty. `title` stays top-level
   * (load-bearing) and remains the source of {{title}}.
   */
  meta?: {
    author?: string
    company?: string
    subject?: string
    event?: string
    keywords?: string
  }
  /** slide coordinate space, px */
  size: { width: number; height: number }
  theme: {
    background: string
    color: string
    accent: string
    fontFamily: string
    /** ordered series colours for new charts; derived from accent when absent */
    chartPalette?: string[]
    /** defaults for newly inserted tables; omitted decks keep the standard look */
    table?: Partial<TableStyle>
  }
  /** present-mode chrome; decks with built-in chrome can turn Reveal's off */
  present?: {
    slideNumber?: boolean
    controls?: boolean
    progress?: boolean
  }
  /** shared assets (raw SVG markup or data URIs), referenced by key */
  assets?: Record<string, string>
  /**
   * ONE shared green/blue-screen calibration for the whole presentation —
   * every camera element with `chromaKeyEnabled: true` (see MediaElement)
   * uses this same removal, never a per-element one. A presentation only
   * has one physical camera+backdrop setup at a time, and it needs
   * recalibrating fresh right before each recording anyway (lighting
   * changes, the backdrop gets bumped, etc.) — sharing it here means
   * doing that once updates every camera element in the deck at once,
   * rather than needing to redo it per element/per slide.
   *
   * Removal is DYNAMIC — computed fresh every frame from `color`/
   * `similarity`/`smoothness`, not a fixed spatial mask. A static mask
   * captured once from a snapshot fundamentally can't handle a person
   * actually moving in front of the camera: parts of them constantly move
   * into positions the snapshot recorded as "background" (now wrongly
   * kept transparent, cutting into the subject) or the reverse (now
   * wrongly kept opaque, leaving a background patch visible) — dynamic,
   * per-pixel colour comparison against every live frame is the only way
   * that keeps working as the subject moves.
   *
   * `touchUpMask` is an OPTIONAL supplementary correction for spots color
   * comparison alone can't fix — a fixed prop or backdrop seam that
   * happens to share a similar hue to the subject, say — multiplied
   * (never replacing) into the dynamic result. Same authoring tools/
   * storage format as a static image's own cutout mask (editor/
   * imagemask.ts's ImageMaskEditor): "asset:<key>" or a data: URI.
   *
   * The calibration flow (editor/panels.ts's "Greenscreen kalibrieren")
   * captures one frame, has the person click the backdrop directly to
   * sample `color` (reads that one pixel — no mask-editor tool needed for
   * this part), then optionally opens the mask editor on that same
   * snapshot for eraser/box/ellipse touch-up only, saving whatever
   * resulted into `touchUpMask`.
   */
  cameraCalibration?: {
    color: string
    /** 0-100 — how close a pixel's colour must be to `color` to be
     *  removed. Higher = more colours count as "close enough" (more
     *  aggressive removal, more risk of eating into the subject).
     *  Defaults to 38 when unset. */
    similarity?: number
    /** 0-100 — width of the soft edge between "kept" and "removed"
     *  pixels, avoiding a hard, aliased cutout edge. Defaults to 12. */
    smoothness?: number
    touchUpMask?: string
  }
  /**
   * Live-collab blob references for LARGE assets (docs/blob-offload.md).
   *
   * An asset over BLOB_INLINE_MAX cannot travel as a CRDT op — a Durable
   * Object storage value caps near 2MB — so its bytes go to the relay's blob
   * store and only this tiny reference is synced. Receiving peers fetch,
   * decrypt and materialise the asset into `assets` themselves.
   *
   * NOT part of the document at rest in any meaningful sense: a saved file
   * carries the real bytes in `assets`, and opening it standalone ignores this
   * map entirely. It is additive and optional — older builds simply preserve
   * it as an unknown field.
   */
  blobs?: Record<string, { key: string; mime: string; size: number }>
  /**
   * embedded fonts: each entry becomes an @font-face at boot, with the font
   * data living in assets (data: URI). Elements then use `family` normally.
   */
  fonts?: Array<{ family: string; asset: string; weight?: string; style?: string }>
  /**
   * Slide layouts: slide-shaped templates that live outside slides[].
   * Instantiating one deep-copies its elements KEEPING their ids — slides
   * born from the same layout share ids, so their common chrome morphs
   * across transitions and stays traceable for a future re-apply merge.
   * When absent, the editor offers its built-in starter layouts.
   */
  layouts?: Slide[]
  /**
   * Live-collaboration credentials (bento-sync), minted AT CREATION so any
   * copy of the file can join once sharing is turned on ("send the file
   * first, share later" just works). `room` is the relay WebSocket URL
   * (random id — never derived from docId), `key` the base64url AES-GCM
   * room key. `on` gates auto-join: absent = true (v0.8.0 files only carried
   * collab while actively shared). Possession of a copy IS the capability;
   * "Rotate keys" re-mints both to cut old copies off. `sync` is the saved
   * CRDT state (registers/liveness/text) stamped at save-time on shared
   * documents — it is what lets an offline-edited copy rejoin as a true
   * fork and merge both ways. Never transmitted as sync ops.
   */
  collab?: {
    room: string
    key: string
    on?: boolean
    sync?: import('./sync/crdt').SyncStateJSON
    /**
     * Signed writes (v0.9.18+): the WRITE capability is an ECDSA P-256 keypair,
     * distinct from the symmetric `key` (the READ capability). `writerPub`
     * (raw, base64url) travels in EVERY copy so the relay can verify authorship;
     * `writerPriv` (PKCS#8, base64url) travels ONLY in writer copies. A
     * read-only copy is a writer copy with `writerPriv` stripped — the relay
     * (for `w`-scheme rooms) then drops any op it tries to send. Absent on
     * legacy `r`-scheme rooms, which stay permissive. See docs/collab-design.md.
     */
    writerPub?: string
    writerPriv?: string
    /** 'reader' = this copy is a live viewer: receives updates, never sends. */
    role?: 'writer' | 'reader'
    /**
     * Fine-grained access (v1.0.3+, `v: 2`): per-person keys. The room id
     * commits to the OWNER's pubkey. A member copy carries an INVITE — an
     * owner-signed delegation keypair — and each device mints its own identity
     * key (kept in localStorage, never in the file); the chain
     * owner → invite → member is what the blind relay verifies. `ownerPriv`
     * travels ONLY in the owner's own copy. See docs/collab-design.md roadmap.
     */
    v?: number
    owner?: string
    ownerPriv?: string
    invite?: {
      pub: string
      priv: string
      role: 'writer' | 'commenter'
      /** unix ms expiry; 0/absent = no expiry */
      exp?: number
      /** owner's signature over `inv.${pub}.${role}.${exp||0}` */
      sig: string
    }
  }
  /**
   * Template file (.dotx-style): every OPEN instantiates a fresh document —
   * parseDoc strips this flag, mints a new docId and drops collab, so each
   * person who opens the template gets an independent deck with its own
   * identity and credentials. The template file itself never changes (there
   * is no file handle until the user's first save-as).
   */
  template?: boolean
  /**
   * A read-only PLAYER file: boots straight into the presentation and never
   * shows the editor. Honor-system (the JSON is right there), but it makes a
   * hand-out copy present-only for everyone who doesn't go digging.
   */
  readonly?: boolean
  slides: Slide[]
  modified: string
}

let counter = 0
export const uid = (prefix = 'el') =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/**
 * An element's effective morph key: the `morphId` override when set, else its
 * own `id`. THE single definition — render.ts stamps it into `data-flip-id`,
 * present.ts pairs and looks up model frames by it, and the panel uses it for
 * collision checks. Computing it inline in more than one place is exactly how
 * issue #54 happened: present.ts's model map keyed by `id` while every lookup
 * passed a flip id, so any element carrying a `morphId` silently missed and
 * never morphed. Route every morph-key read through here.
 */
export function morphKey(el: Pick<ElementBase, 'id' | 'morphId'>): string {
  return el.morphId || el.id
}

/** True when a background reads as light (so it wants dark text on top). Accepts
 *  a #rrggbb hex; for a gradient/CSS string it samples the first hex it finds and
 *  falls back to "light" (the safe assumption for the model's dark default ink). */
export function isLightBg(bg: string): boolean {
  const hex = /#([0-9a-fA-F]{6})/.exec(bg || '')
  if (!hex) return true
  const n = parseInt(hex[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 // sRGB relative luminance
}

/** A text colour that stays legible on the given background — new text/tables use
 *  this so a fresh element is never invisible on a dark deck. */
export function readableInk(bg: string): string {
  return isLightBg(bg) ? '#1E2A3A' : '#F5F7FA'
}

export function defaultText(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: uid('t'),
    type: 'text',
    x: 340, y: 300, w: 600, h: 120,
    rotation: 0, opacity: 1,
    html: 'Double-click to edit',
    fontSize: 32,
    fontFamily: FONT_STACK,
    fontWeight: 400,
    color: '#1E2A3A',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.25,
    ...partial,
  }
}

// --- chart palette -----------------------------------------------------------
// New charts should wear the deck's colours, not a stock palette. A deck can
// declare theme.chartPalette; otherwise we synthesise a harmonious set from the
// single accent (accent + a cool structural counterpart, each with a light and
// deep tint) so any deck gets on-brand charts out of the box.

function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0; const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  const to = (v: number) => Math.round((v + mm) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export function deriveChartPalette(accent: string): string[] {
  let h: number, s: number, l: number
  try { [h, s, l] = hexToHsl(accent) } catch { return ['#5470c6', '#91cc75', '#fac858', '#ee6666'] }
  const coolH = h + 190
  return [
    accent,
    hslToHex(coolH, Math.max(20, s * 0.5), Math.min(56, Math.max(44, l))),        // cool counterpart
    hslToHex(h, s * 0.92, Math.min(84, l + 14)),                                  // accent light
    hslToHex(coolH, Math.max(16, s * 0.38), Math.min(74, l + 20)),               // cool light
    hslToHex(h, s, Math.max(28, l - 16)),                                         // accent deep
    hslToHex(coolH, Math.max(24, s * 0.55), Math.max(26, l - 6)),                // cool deep
  ]
}

// --- table → chart data extraction (shared by creation + live binding) -------

const stripCell = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').replace(/,/g, '').trim()

/** First column = x labels; each mostly-numeric column after = a data series. */
export function tableChartColumns(table: TableElement): { labels: string[]; cols: Array<{ name: string; data: number[]; isPct: boolean }> } {
  const bodyRows = table.header ? table.rows.slice(1) : table.rows
  const headerRow = table.header ? table.rows[0] : null
  const labels = bodyRows.map((r) => stripCell(r.cells[0]?.html ?? ''))
  const cols: Array<{ name: string; data: number[]; isPct: boolean }> = []
  for (let c = 1; c < table.columns.length; c++) {
    const raw = bodyRows.map((r) => r.cells[c]?.html ?? '')
    const parsed = raw.map((h) => parseFloat(stripCell(h)))
    if (parsed.filter((n) => !Number.isNaN(n)).length < Math.ceil(bodyRows.length / 2)) continue
    cols.push({
      name: headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '',
      data: parsed.map((n) => (Number.isNaN(n) ? 0 : n)),
      isPct: /%/.test(headerRow ? stripCell(headerRow.cells[c]?.html ?? '') : '') ||
        raw.filter((h) => /%/.test(h)).length >= Math.ceil(bodyRows.length / 2),
    })
  }
  return { labels, cols }
}

/**
 * Push a linked table's current values into a chart's option IN PLACE,
 * preserving the chart's styling/axis config (only xAxis labels + each series'
 * data change). Returns true if anything changed. Series map to numeric columns
 * by position; extra series/columns are left untouched.
 */
export function syncLinkedChart(chart: ChartElement, table: TableElement): boolean {
  const before = JSON.stringify(chart.option)
  const { labels, cols } = tableChartColumns(table)
  const opt = chart.option as { xAxis?: any; series?: any }
  if (opt.xAxis && !Array.isArray(opt.xAxis) && typeof opt.xAxis === 'object') opt.xAxis.data = labels
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
  series.forEach((s, i) => {
    if (!s || !cols[i]) return
    if (s.type === 'pie') s.data = labels.map((name, j) => ({ name, value: cols[i].data[j] ?? 0 }))
    else s.data = cols[i].data
  })
  return JSON.stringify(chart.option) !== before
}

export function chartColorsFor(theme: BentoDoc['theme']): string[] {
  return theme.chartPalette?.length ? theme.chartPalette.slice() : deriveChartPalette(theme.accent)
}

/** Give a chart option the deck's palette unless it already sets explicit colours. */
export function applyChartPalette<T extends Record<string, unknown>>(option: T, theme: BentoDoc['theme']): T {
  const cur = (option as { color?: unknown }).color
  if (!Array.isArray(cur) || cur.length === 0) (option as { color?: string[] }).color = chartColorsFor(theme)
  return option
}

export function defaultChart(option: Record<string, unknown>, partial: Partial<ChartElement> = {}): ChartElement {
  return {
    id: uid('c'),
    type: 'chart',
    x: 400, y: 190, w: 800, h: 520,
    rotation: 0, opacity: 1,
    preset: 'bar',
    option,
    ...partial,
  }
}

const DEFAULT_TABLE_STYLE: TableStyle = {
  headerBg: '#1E2A3A',
  headerColor: '#FFFFFF',
  zebra: 'rgba(30,42,58,0.05)',
  borderColor: 'rgba(30,42,58,0.14)',
  borderWidth: 1,
  cellPadX: 16,
  cellPadY: 11,
  fontSize: 18,
  color: '#1E2A3A',
  radius: 10,
}

/** Resolve a new table's style from built-in defaults and optional deck overrides. */
export function tableStyleFor(theme?: BentoDoc['theme']): TableStyle {
  return { ...DEFAULT_TABLE_STYLE, ...(theme?.table ?? {}) }
}

export function defaultTable(
  partial: Partial<TableElement> = {},
  theme?: BentoDoc['theme'],
): TableElement {
  const cell = (html: string): TableCell => ({ html })
  return {
    id: uid('tbl'),
    type: 'table',
    x: 240, y: 220, w: 800, h: 260,
    rotation: 0, opacity: 1,
    header: true,
    columns: [{ w: 1 }, { w: 1 }, { w: 1 }],
    rows: [
      { cells: [cell('Column A'), cell('Column B'), cell('Column C')] },
      { cells: [cell('Row 1'), cell('—'), cell('—')] },
      { cells: [cell('Row 2'), cell('—'), cell('—')] },
    ],
    style: tableStyleFor(theme),
    ...partial,
  }
}

export function defaultShape(shape: ShapeKind, partial: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: uid('s'),
    type: 'shape',
    shape,
    x: 490, y: 260, w: 300, h: 200,
    rotation: 0, opacity: 1,
    fill: '#F7A600',
    stroke: 'transparent',
    strokeWidth: 0,
    radius: shape === 'rect' ? 12 : 0,
    ...partial,
  }
}

export function defaultImage(src: string, partial: Partial<ImageElement> = {}): ImageElement {
  return {
    id: uid('i'),
    type: 'image',
    x: 440, y: 210, w: 400, h: 300,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: 0,
    ...partial,
  }
}

/** Park an embedded data URI in `doc.assets` and return an `asset:` ref.
 *
 *  Every embed goes through here so there is exactly ONE place binary content
 *  lives. That matters beyond tidiness: live collab offloads large `assets`
 *  entries to the relay's blob store, so an image written straight onto
 *  `el.src` was invisible to the offload and rode inline in an op batch far
 *  too big for a frame — it reached collaborators as nothing at all.
 *
 *  Identical bytes reuse the same key, so duplicating an image (or pasting the
 *  same photo twice) costs one copy in the file and one upload on the wire.
 *  A URL or an existing `asset:` ref passes straight through — only `data:`
 *  is interned. Callers MUST run this inside a `store.commit` so the assets
 *  write is part of the same undo step and the same sync batch. */
export function internAsset(doc: BentoDoc, src: string): string {
  if (!src.startsWith('data:')) return src
  const assets = (doc.assets ??= {})
  for (const k in assets) if (assets[k] === src) return `asset:${k}`
  const key = uid('a')
  assets[key] = src
  return `asset:${key}`
}

/** Soft ceiling for embedding media as a data URI (bytes). Above this the
 *  editor warns — a big embed makes the .bento.html slow to open and save. */
export const MEDIA_EMBED_BUDGET = 8 * 1024 * 1024 // 8 MB

/**
 * Hard ceiling for the static first-page preview every save writes into the
 * shell (src/preview.ts), in bytes of serialized markup.
 *
 * Unlike MEDIA_EMBED_BUDGET this is not a warning the author can wave through
 * — there is no author in the loop, it is spent silently on every ⌘S, and it
 * is spent on a THUMBNAIL. A text page costs 2–5 KB. The thing that can blow
 * up is a full-bleed photo, whose data URI would be duplicated: once in the
 * document, once in the preview.
 *
 * 64 KB is ~10% of the shipped shell (~640 KB compressed): invisible against a
 * file that size, and enough for a real page plus a logo or an icon-sized
 * image. Measured: the starter deck's page one costs 25 KB (2.6% of it). Over
 * it, preview.ts degrades — first dropping raster payloads, then falling back
 * to a title card — rather than growing the file.
 */
export const PREVIEW_BUDGET = 64 * 1024 // 64 KB

export function defaultMedia(
  kind: 'video' | 'audio' | 'camera',
  src: string,
  partial: Partial<MediaElement> = {},
): MediaElement {
  const audio = kind === 'audio'
  return {
    id: uid('m'),
    type: 'media',
    kind,
    x: 440, y: 210,
    w: audio ? 460 : 560, h: audio ? 56 : 315,
    rotation: 0, opacity: 1,
    src,
    fit: 'contain',
    radius: audio ? 12 : 8,
    controls: kind !== 'camera',
    // video defaults muted so present-mode autoplay is permitted by browsers
    muted: !audio,
    loop: false,
    autoplay: false,
    ...partial,
  }
}

export function emptySlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: uid('slide'),
    background: '#FFFFFF',
    transition: 'fade',
    elements: [],
    notes: '',
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Layouts. A layout is a Slide that lives in doc.layouts (or the built-in
// set below). Element ids are deterministic per layout and are KEPT when a
// layout is instantiated: slides born from the same layout share ids, so
// their common chrome morphs across transitions.

const ph = (
  id: string,
  placeholder: string,
  frame: { x: number; y: number; w: number; h: number },
  type: Partial<TextElement> = {},
): TextElement => ({
  id,
  type: 'text',
  ...frame,
  rotation: 0, opacity: 1,
  html: '',
  placeholder,
  fontSize: 32,
  fontFamily: FONT_STACK,
  fontWeight: 400,
  color: '#1E2A3A',
  align: 'left',
  valign: 'top',
  lineHeight: 1.25,
  ...type,
})

const bar = (id: string, frame: { x: number; y: number; w: number; h: number }): ShapeElement => ({
  id, type: 'shape', shape: 'rect', ...frame,
  rotation: 0, opacity: 1, fill: '#F7A600', stroke: 'transparent', strokeWidth: 0, radius: 2,
})

/**
 * The canvas the built-in layout geometry below is authored against.
 *
 * It is NOT the model default (1280x720) — these layouts were drawn for a
 * 1600x900 stage, so on a default deck every one of them used to hang off the
 * right edge (`lt-title` ran to x=1440 on a 1280-wide slide) and the
 * title+content body overflowed the bottom by 88px. `builtinLayouts(size)`
 * scales them to the deck instead, which also makes them correct for the
 * custom page sizes the slide panel offers.
 */
const LAYOUT_BASE = { width: 1600, height: 900 }

/** Rescale a built-in layout from LAYOUT_BASE onto an arbitrary canvas. */
function scaleLayout(ly: Slide, sx: number, sy: number): Slide {
  // Type scales with the SMALLER axis: on a squarer canvas the limiting
  // dimension is what decides whether a heading still fits its box.
  const st = Math.min(sx, sy)
  return {
    ...ly,
    elements: ly.elements.map((el) => {
      const next = {
        ...el,
        x: Math.round(el.x * sx), y: Math.round(el.y * sy),
        w: Math.round(el.w * sx), h: Math.round(el.h * sy),
      } as SlideElement
      if (next.type === 'text') {
        const txt = next as TextElement
        if (txt.fontSize) txt.fontSize = Math.max(8, Math.round(txt.fontSize * st))
        if (txt.letterSpacing) txt.letterSpacing = Math.round(txt.letterSpacing * st * 10) / 10
      }
      return next
    }),
  }
}

/**
 * The layouts every document offers out of the box (not persisted until edited).
 * Pass the deck's page size to get geometry that fits it; omit it only when the
 * caller just wants the element ids.
 */
export function builtinLayouts(size?: { width: number; height: number }): Slide[] {
  const base: Slide[] = [
    {
      id: 'layout-title', name: 'Title', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        bar('lt-bar', { x: 160, y: 380, w: 72, h: 8 }),
        ph('lt-title', 'Click to add title', { x: 160, y: 404, w: 1280, h: 140 },
          { fontSize: 76, fontWeight: 700, valign: 'middle', role: 'title' }),
        ph('lt-sub', 'Click to add subtitle', { x: 160, y: 556, w: 1100, h: 60 },
          { fontSize: 28, color: '#45566B', valign: 'middle', role: 'subtitle' }),
      ],
    },
    {
      id: 'layout-title-content', name: 'Title + content', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('ltc-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('ltc-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('ltc-body', 'Click to add content', { x: 120, y: 208, w: 1360, h: 600 },
          { fontSize: 26, color: '#586A80', valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-two-col', name: 'Two columns', background: '#FFFFFF', transition: 'fade', notes: '', elements: [
        ph('l2c-title', 'Click to add title', { x: 120, y: 72, w: 1360, h: 84 },
          { fontSize: 44, fontWeight: 700, valign: 'middle', role: 'title' }),
        bar('l2c-rule', { x: 120, y: 168, w: 1360, h: 3 }),
        ph('l2c-left', 'Left column', { x: 120, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
        ph('l2c-right', 'Right column', { x: 820, y: 208, w: 660, h: 600 },
          { fontSize: 24, valign: 'top', lineHeight: 1.5, role: 'body' }),
      ],
    },
    {
      id: 'layout-section', name: 'Section divider', background: '#1E2A3A', transition: 'fade', notes: '', elements: [
        bar('lsec-bar', { x: 160, y: 396, w: 72, h: 8 }),
        ph('lsec-title', 'Section title', { x: 160, y: 420, w: 1280, h: 120 },
          { fontSize: 64, fontWeight: 700, color: '#FFFFFF', valign: 'middle', role: 'title' }),
        ph('lsec-kicker', 'PART 1', { x: 160, y: 350, w: 800, h: 40 },
          { fontSize: 18, fontWeight: 600, color: '#F7A600', letterSpacing: 3, valign: 'middle', role: 'kicker' }),
      ],
    },
    { id: 'layout-blank', name: 'Blank', background: '#FFFFFF', transition: 'fade', notes: '', elements: [] },
  ]
  if (!size || (size.width === LAYOUT_BASE.width && size.height === LAYOUT_BASE.height)) return base
  const sx = size.width / LAYOUT_BASE.width
  const sy = size.height / LAYOUT_BASE.height
  return base.map((ly) => scaleLayout(ly, sx, sy))
}

/** A fresh slide from a layout — new slide id, element ids KEPT (lineage). */
export function instantiateLayout(layout: Slide): Slide {
  const copy: Slide = JSON.parse(JSON.stringify(layout))
  return { ...copy, id: uid('slide'), name: undefined, stateOf: undefined, notes: '' }
}

const textHasContent = (e: SlideElement) =>
  e.type !== 'text' || !!e.html.replace(/<br\s*\/?>/gi, '').replace(/\u200B/g, '').trim()

/**
 * Apply a layout to an existing slide's elements. The matching ladder:
 *   1. by id     — re-applying the slide's own layout resets frames/typography
 *                  while keeping content
 *   2. by role   — cross-layout: the slide's 'title' moves into the new
 *                  layout's 'title' frame (same element type required;
 *                  donors consumed in document order)
 * Content (text html, link) rides along; the layout provides frame and
 * typography. Leftover slide elements that belong to some KNOWN layout
 * (old chrome, unfilled placeholders) are dropped; everything else is user
 * content and survives on top of the new layout's elements.
 */
export function applyLayout(
  slide: Slide,
  layout: Slide,
  knownLayoutElementIds: Set<string>,
): SlideElement[] {
  const donors = slide.elements
  const consumed = new Set<SlideElement>()
  const findDonor = (lel: SlideElement): SlideElement | undefined => {
    const byId = donors.find((e) => !consumed.has(e) && e.id === lel.id)
    if (byId) return byId
    if (!lel.role) return undefined
    return donors.find(
      (e) => !consumed.has(e) && e.role === lel.role && e.type === lel.type && textHasContent(e),
    )
  }
  const out: SlideElement[] = layout.elements.map((lel) => {
    const copy = JSON.parse(JSON.stringify(lel)) as SlideElement
    const d = findDonor(lel)
    if (d) {
      consumed.add(d)
      if (copy.type === 'text' && d.type === 'text' && textHasContent(d)) copy.html = d.html
      if (d.link) copy.link = d.link
    }
    return copy
  })
  for (const e of donors) {
    if (consumed.has(e)) continue
    // layout-owned leftovers: drop chrome and EMPTY placeholders, but text
    // someone actually wrote is never silently lost — it rides along as-is
    if (knownLayoutElementIds.has(e.id) && !(e.type === 'text' && textHasContent(e))) continue
    out.push(e) // survives, painted above the layout
  }
  return out
}

/** Every element id owned by any known layout (built-ins + the document's). */
export function layoutElementIds(doc: BentoDoc): Set<string> {
  const ids = new Set<string>()
  for (const ly of [...builtinLayouts(), ...(doc.layouts ?? [])]) {
    for (const e of ly.elements) ids.add(e.id)
  }
  return ids
}

export const newDocId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : uid('doc')

export function newDoc(): BentoDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: newDocId(),
    title: 'Untitled',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent: '#F7A600',
      fontFamily: FONT_STACK,
    },
    slides: [emptySlide()],
    modified: new Date().toISOString(),
  }
}

export function parseDoc(json: string): BentoDoc | null {
  try {
    const doc = JSON.parse(json)
    if (doc && doc.format === FORMAT && Array.isArray(doc.slides) && doc.slides.length > 0) {
      // Documents from before docId existed get one minted here; it persists
      // on the next save and stays stable from then on.
      if (typeof doc.docId !== 'string' || !doc.docId) doc.docId = newDocId()
      if (doc.template) {
        // template instantiation: this open IS a new document
        delete doc.template
        doc.docId = newDocId()
        delete doc.collab
      }
      return doc as BentoDoc
    }
  } catch {
    /* fall through */
  }
  return null
}
