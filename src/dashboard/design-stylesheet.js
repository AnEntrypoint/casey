import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const DESIGN_STYLESHEET = path.join('dist', '247420.css')
export const DESIGN_THEME_OVERLAY = 'design-theme.css'

export function composeStylesheet(built, overlayDir, anchor) {
  const overlayPath = overlayDir ? path.join(overlayDir, DESIGN_THEME_OVERLAY) : null
  if (!overlayPath || !existsSync(overlayPath)) return built
  const overlay = readFileSync(overlayPath, 'utf8')
  if (anchor == null) return built + overlay
  const first = built.indexOf(anchor)
  if (first < 0 || built.indexOf(anchor, first + 1) >= 0) throw new Error('brand.yml design_theme_anchor must occur exactly once in the built design stylesheet')
  const at = first + anchor.length
  return built.slice(0, at) + overlay + '\n' + built.slice(at)
}

export function designStylesheetRoute(designDir, overlayDir, anchor = null) {
  let body = null
  return (_req, res, next) => {
    const built = path.join(designDir, DESIGN_STYLESHEET)
    if (!existsSync(built)) return next()
    if (body === null) body = composeStylesheet(readFileSync(built, 'utf8'), overlayDir, anchor)
    res.setHeader('Cache-Control', 'no-cache')
    res.type('text/css').send(body)
  }
}
