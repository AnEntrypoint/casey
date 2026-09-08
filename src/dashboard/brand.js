// ONE resolution of a deployment's brand, for every server-rendered surface.
//
// server.js already resolved a deployer's real branding for the PWA -- brand
// name from DASHBOARD_UI.brand, ground colour parsed out of index.html's own
// <meta name="theme-color">, and an ink colour COMPUTED from that ground's
// luminance rather than assumed white. manifest.json, the generated icon and
// offline.html consumed it. Three other server-rendered surfaces did not, and
// each hand-rolled its own palette instead: the public /report form (a stock
// blue #2f6fb0 with a progress bar at #f0a030 -- a near-miss of this
// deployment's actual brand orange #E88427, not the brand orange), the
// printable case briefing (#2f6fb0 again), and the management-report
// stylesheet (bare #1a1a1a/#ccc). A deployer therefore had four different
// answers to "what colour is this product", and the one surface a reporting
// contact ever sees carried none of their brand at all.
//
// This module is that single answer. It is deliberately dependency-free and
// synchronous: /report is reached with NO session and NO design-kit bundle, so
// it cannot import the SPA design system, and the pages that consume this are
// plain server-rendered HTML with an inline <style> block.
//
// WHY THE DERIVED TONES ARE COMPUTED AND NOT LISTED. A brand ships exactly one
// colour here (the theme-color tag), but a page needs several: a fill, a
// hover, a soft panel wash, a hairline, and a text tone. Writing those out as
// literals would put us straight back where we started -- five constants that
// drift from the one that is real. Each is mixed from the ground instead, so a
// deployer changing one meta tag moves the whole page.
//
// WHY THE TEXT TONE IS NOT THE BRAND COLOUR ITSELF. Brand colours are chosen
// to be seen as a FILL. Used as small text on a light page, a bright one fails
// readability outright: this deployment's #E88427 measures 2.50:1 on the form's
// #f4f6f9 ground, well under the 4.5:1 text floor, so the old hardcoded blue
// was accidentally more readable than the real brand would have been. `accent`
// is therefore the ground darkened, one percent at a time, only until it
// actually clears 4.5:1 against the lightest surface it is drawn on -- measured
// each step, never assumed. A ground that already clears it is left untouched
// (#3b6ea5 stops at zero steps), so this darkens nothing that does not need it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DASHBOARD_UI, REPORT_ENTITY_LABEL } from '../store/report-shape.js'

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public')

// The colour a deployer gets when index.html carries no readable theme-color.
// Same literal server.js's own readThemeColor() used, kept so an unconfigured
// deployment resolves exactly what it resolved before this module existed.
const FALLBACK_GROUND = '#3b6ea5'

// index.html's own <meta name="theme-color"> is the single source for the brand
// colour. It had drifted once already: the page declared #E88427 while the
// manifest and the generated icon both hardcoded #3b6ea5, so browser chrome,
// task-switcher entry and home-screen icon were three different colours for one
// product. Reading the page's own tag makes that divergence unrepresentable
// rather than merely fixed once.
export function readThemeColor(publicDir = PUBLIC_DIR) {
  try {
    const m = /<meta\s+name="theme-color"\s+content="([^"]+)"/i.exec(readFileSync(path.join(publicDir, 'index.html'), 'utf8'))
    if (m) return m[1]
  } catch { /* a deployer replacing index.html keeps casey's own colour */ }
  return FALLBACK_GROUND
}

// A theme-color tag may legally say #abc, or a colour keyword, or an rgb()
// form. Those are all fine to hand straight back to CSS, and all useless to
// arithmetic. normalizeHex is the arithmetic edge: 6-digit hex out, or null
// when there is nothing to compute with, so a caller decides what to do about
// it instead of getting NaN silently folded into a ratio.
export function normalizeHex(value) {
  const s = String(value == null ? '' : value).trim()
  const six = /^#?([0-9a-fA-F]{6})$/.exec(s)
  if (six) return '#' + six[1].toLowerCase()
  const three = /^#?([0-9a-fA-F]{3})$/.exec(s)
  if (three) return '#' + three[1].toLowerCase().split('').map(c => c + c).join('')
  return null
}

// WCAG relative luminance. Returns null rather than NaN for an unparseable
// colour, so every caller has to face the missing value.
export function relativeLuminance(hex) {
  const norm = normalizeHex(hex)
  if (!norm) return null
  const n = parseInt(norm.slice(1), 16)
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

// The measured WCAG contrast ratio between two colours, 1..21. This is the
// number that makes "is this readable" answerable instead of arguable; every
// tone below is picked by consulting it, and it is exported so a live check can
// re-measure the shipped palette rather than trust this comment.
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

// White-on-brand is the single most common way a palette ships an unreadable
// mark, and this deployment is a live example: white on #E88427 measures
// 2.71:1 -- under even the 3:1 UI floor -- while black on the same orange
// measures 7.76:1. So ink is picked from the fill's own luminance.
//
// Behaviour is deliberately byte-identical to the copy this replaced in
// server.js, three-character return values included: it feeds the generated
// icon's SVG, and changing '#fff' to '#ffffff' would change that file's bytes
// (and therefore its cache identity) for no visual difference at all.
export function readableInkOn(hex) {
  const norm = normalizeHex(hex)
  if (!norm) return '#fff'
  const L = relativeLuminance(norm)
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000' : '#fff'
}

// Linear channel mix, t=0 is `from`, t=1 is `to`. Not a colour-science blend
// (no gamma correction) on purpose -- these are decorative washes, and the one
// tone where perceptual accuracy actually matters (`accent`) is not trusted to
// the mix at all, it is measured afterwards.
export function mixHex(from, to, t) {
  const a = normalizeHex(from)
  const b = normalizeHex(to)
  if (!a || !b) return normalizeHex(from) || FALLBACK_GROUND
  let out = '#'
  for (let i = 1; i < 7; i += 2) {
    const va = parseInt(a.slice(i, i + 2), 16)
    const vb = parseInt(b.slice(i, i + 2), 16)
    out += Math.round(va + (vb - va) * t).toString(16).padStart(2, '0')
  }
  return out
}

// Darken `hex` against `on` until it MEASURES at least `floor`. Steps of 1%
// toward black, re-measuring each step; black clears every floor against a
// light ground, so this always terminates. The loop is the point: it does the
// least darkening that actually reaches the floor, rather than applying a fixed
// "make it darker" fudge that would over-darken one brand and under-darken the
// next.
export function darkenUntilReadable(hex, on, floor = 4.5) {
  const base = normalizeHex(hex)
  const ground = normalizeHex(on)
  if (!base || !ground) return base || FALLBACK_GROUND
  let candidate = base
  for (let t = 0; t <= 100; t += 1) {
    const ratio = contrastRatio(candidate, ground)
    if (ratio !== null && ratio >= floor) return candidate
    candidate = mixHex(base, '#000000', (t + 1) / 100)
  }
  return '#000000'
}

// The whole palette a server-rendered page needs, from the one colour a
// deployer actually declares. Exported as a function so a caller can resolve a
// different public dir (and so the derivation is inspectable/re-runnable
// against any ground), with the process-wide answer frozen below.
export function resolveBrand({ publicDir = PUBLIC_DIR, dashboardUi = DASHBOARD_UI, entityLabel = REPORT_ENTITY_LABEL } = {}) {
  // Raw, as written: handed to CSS and to manifest.json verbatim, so a
  // deployer's `#abc` or colour keyword survives untouched.
  //
  // dashboard_ui.theme_color comes FIRST because until it existed there was no
  // config channel for the ground at all -- the name was configurable and the
  // colour was not, so the only way to brand a deployment's colour was to edit
  // casey's own tracked public/index.html. That is exactly what had happened:
  // the shipped file carried one deployer's orange and their product name, and
  // this function read it as "casey's own default", so every OTHER deployer
  // silently inherited it. The meta tag stays as the fallback, so a deployment
  // that branded itself the old way keeps working with no config change.
  const ground = normalizeHex(dashboardUi?.theme_color) ? dashboardUi.theme_color : readThemeColor(publicDir)
  // Normalised, for arithmetic only. An unparseable tag still paints (CSS gets
  // the raw value) but the derived tones fall back rather than compute garbage.
  const hex = normalizeHex(ground) || FALLBACK_GROUND
  const soft = mixHex(hex, '#ffffff', 0.90)
  return Object.freeze({
    name: dashboardUi?.brand || 'casey',
    // dashboard_ui.description is the same optional, deployer-owned string
    // manifest.json already uses -- absent, a page shows the brand name and
    // claims nothing about a domain casey does not know it is in.
    description: dashboardUi?.description || null,
    entityLabel,
    ground,
    ink: readableInkOn(hex),
    hover: mixHex(hex, '#000000', 0.18),
    soft,
    edge: mixHex(hex, '#ffffff', 0.62),
    // Measured against `soft`, the darkest of the light surfaces this tone is
    // drawn on (a soft wash of a warm brand sits slightly below a cool page
    // grey), so clearing the floor there clears it on the page and on white too.
    accent: darkenUntilReadable(hex, soft, 4.5),
  })
}

export const BRAND = resolveBrand()
