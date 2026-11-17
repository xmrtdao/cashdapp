# Modern web patterns for OpenFilm scenes

OpenFilm renders every frame from HTML/CSS in headless Chromium, so web-platform
quality **is** film quality. These patterns come from the
`modern-web-guidance` skill (GoogleChrome/modern-web-guidance); retrieve the
named guide with `npx -y modern-web-guidance@latest retrieve "<id>"` before
extending this set.

## The pattern set (applied in `scenes/title.html` and `modern-lower-third.html`)

| Guide | Rule | Why it matters on film |
|---|---|---|
| `visual-effects` | Gradient endpoints in `oklch()`, interpolated `in oklab` for neutrals; `in oklch` only between two distinct saturated hues | `in srgb` gradients go muddy; low-chroma `oklch` interpolation has a Chromium powerless-hue bug that tints toward magenta |
| `visual-effects` | Layer shadows: tight contact shadow + wide ambient shadow | Single flat shadows read as cheap on a 1920×1080 frame |
| `precise-text-alignment` | `text-box: trim-both cap alphabetic` — both edges must be declared | Kills the font's "ghost leading" so `top:` positions the actual cap top and badge padding hugs the glyphs |
| `improve-text-layout-and-legibility` | `text-wrap: balance` on short heading blocks only, never globally | Balanced line breaks on titles; the binary-search algorithm is too expensive to apply everywhere |
| `individual-transform-properties` | `translate` / `scale` instead of `transform:`, with identity bases (`translate: 0px; scale: 1;`) declared up front | Independent properties compose in a per-frame driver without clobbering each other; identity bases keep stacking contexts stable |
| `physics-based-easing` | `linear()` spring stops evaluated per-frame for `frame()`-driven scenes; **never on opacity** | Linear ramps look amateur; spring overshoot on `opacity` flickers (guide's explicit warning) |

## Renderer notes

- Scene `window.film.duration` must match the film length (set by the longest
  audio/video clip) or the tail renders as black frames — seen as a 2.84s black
  tail when the 5s scene met a 7.84s narration.
- Keep per-frame writes to `opacity`, `translate`, `scale` — compositor-friendly
  properties only.
- `backdrop-filter: blur()` renders fine in headless Chromium (frosted-glass
  chips), verified in `.film/cache/look/` contact sheets.
