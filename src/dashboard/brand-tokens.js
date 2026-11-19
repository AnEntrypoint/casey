import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadDomainConfig } from '../config-loader.js'

export const NEUTRAL_TOKENS = Object.freeze({
  THEME_LIGHT: 'light',
  THEME_DARK: 'dark',
  THEME_LEGACY: '{}',
  FONT_SANS: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  FONT_FACES: '',
  FONT_PRELOADS: '',
})

const TOKEN_RE = /__CASEY_([A-Z0-9_]+)__/g

export function brandConfig() {
  const cfg = loadDomainConfig()
  const given = cfg.brand?.tokens || {}
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('brand.yml tokens must be a map of token name to text')
  const tokens = { ...NEUTRAL_TOKENS }
  for (const [name, value] of Object.entries(given)) {
    if (!Object.hasOwn(NEUTRAL_TOKENS, name)) throw new Error(`brand.yml: unknown token ${name}`)
    if (typeof value !== 'string') throw new Error(`brand.yml: token ${name} must be text`)
    tokens[name] = value
  }
  const overlay = path.join(cfg.dir, 'public')
  return Object.freeze({ tokens: Object.freeze(tokens), overlayDir: existsSync(overlay) ? overlay : null })
}

export function applyBrandTokens(text, tokens) {
  return text.replace(TOKEN_RE, (match, name) => {
    if (!Object.hasOwn(tokens, name)) throw new Error(`unknown brand token ${match}`)
    return tokens[name]
  })
}

export function tokenisedAssets(publicDir, tokens) {
  const out = new Map()
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs, rel + e.name + '/'); continue }
      if (!/\.(css|js)$/.test(e.name)) continue
      const text = readFileSync(abs, 'utf8')
      if (text.includes('__CASEY_')) out.set('/' + rel + e.name, applyBrandTokens(text, tokens))
    }
  }
  walk(publicDir, '')
  return out
}
