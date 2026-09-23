// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Generic "play through several standalone documents in sequence" opt-in —
// the host-agnostic half of what editor/moodle.ts's own MoodleConfig.playlist
// already does for Moodle specifically. That version is gated on the URL
// containing "mod/bento" (see readMoodleConfig in moodle.ts) — deliberately,
// since MoodleConfig also carries cmid/sesskey/wwwroot for SAVING back to
// Moodle, and no other host should be mistaken for a live Moodle activity
// just by injecting a similarly-shaped tag. But auto-advancing present mode
// into a NEXT document once the last slide is reached has nothing to do with
// saving — it's just "here's a list of URLs, fetch the next one when asked" —
// and any host page can opt into exactly that by injecting THIS tag instead,
// no URL shape required, the tag's own presence being the whole signal:
//
//   <meta name="bento-playlist" content='{"items":[{"url":"..."}]}'>
//
// Each item's `url` is fetched (plain GET) and parsed as JSON — a bare
// bento/slides document, not a full .bento.html page — only once present
// mode actually reaches it (see main.ts's/editor.ts's own onReachedEnd
// wiring, both of which fall back to this when moodleConfig is absent), so
// viewing a long sequence never means downloading all of it just to see the
// first one.

export interface PlaylistConfig {
  items: { url: string }[]
}

function readPlaylistConfig(): PlaylistConfig | null {
  const meta = document.querySelector('meta[name="bento-playlist"]')
  if (!meta) return null
  const content = meta.getAttribute('content')
  if (!content) return null
  try {
    const cfg = JSON.parse(content)
    if (cfg && Array.isArray(cfg.items) && cfg.items.every((i: unknown) => !!i && typeof (i as { url?: unknown }).url === 'string')) {
      return cfg as PlaylistConfig
    }
    console.log('[bento/playlist] <meta name="bento-playlist"> content parsed but "items" isn\'t an array of {url}:', cfg)
  } catch (e) {
    console.log('[bento/playlist] <meta name="bento-playlist"> content is not valid JSON:', content, e)
  }
  return null
}

/** Read once at module load — the page doesn't navigate without a reload, so this never changes mid-session. */
export const playlistConfig: PlaylistConfig | null = readPlaylistConfig()
