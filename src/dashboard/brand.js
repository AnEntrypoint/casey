import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DASHBOARD_UI, REPORT_ENTITY_LABEL } from '../store/report-shape.js'

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public')

const FALLBACK_GROUND = '#3b6ea5'

export function readThemeColor(publicDir = PUBLIC_DIR) {
  try {
    const m = /<meta\s+name="theme-color"\s+content="([^"]+)"/i.exec(readFileSync(path.join(publicDir, 'index.html'), 'utf8'))
    if (m) return m[1]
  } catch {  }
  return FALLBACK_GROUND
}

export function normalizeHex(value) {
  const s = String(value == null ? '' : value).trim()
  const six = /^#?([0-9a-fA-F]{6})$/.exec(s)
  if (six) return '#' + six[1].toLowerCase()
  const three = /^#?([0-9a-fA-F]{3})$/.exec(s)
  if (three) return '#' + three[1].toLowerCase().split('').map(c => c + c).join('')
  return null
}

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

export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

export function readableInkOn(hex) {
  const norm = normalizeHex(hex)
  if (!norm) return '#fff'
  const L = relativeLuminance(norm)
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000' : '#fff'
}

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

export function resolveBrand({ publicDir = PUBLIC_DIR, dashboardUi = DASHBOARD_UI, entityLabel = REPORT_ENTITY_LABEL } = {}) {
  const ground = normalizeHex(dashboardUi?.theme_color) ? dashboardUi.theme_color : readThemeColor(publicDir)
  const hex = normalizeHex(ground) || FALLBACK_GROUND
  const soft = mixHex(hex, '#ffffff', 0.90)
  return Object.freeze({
    name: dashboardUi?.brand || 'casey',
    description: dashboardUi?.description || null,
    entityLabel,
    ground,
    ink: readableInkOn(hex),
    hover: mixHex(hex, '#000000', 0.18),
    soft,
    edge: mixHex(hex, '#ffffff', 0.62),
    accent: darkenUntilReadable(hex, soft, 4.5),
  })
}

export const BRAND = resolveBrand()

export const TYPE_SCALE_CSS = ':root{'
  + '--fs-micro:0.75rem;--fs-tiny:0.8125rem;--fs-xs:0.875rem;'
  + '--fs-body:1rem;--fs-lg:1.125rem;--fs-xl:1.3125rem;'
  + '--space-half:0.1875rem;--space-1:0.25rem;--space-1-5:0.3125rem;'
  + '--space-2:0.5rem;--space-2-5:0.625rem;--space-2-75:0.75rem;'
  + '--space-3:1rem;--space-3-5:1.25rem;--space-4:1.5rem;--space-5:2rem;--space-6:3rem;'
  + '--lh-snug:1.2;--lh-base:1.55;--bw-hair:1px'
  + '}'
