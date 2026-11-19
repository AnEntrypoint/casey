import fs from 'node:fs'
import path from 'node:path'

const FILE = 'cli-help.json'
let table

function load() {
  if (table !== undefined) return table
  table = null
  const dir = process.env.CASEY_CONFIG_DIR
  if (!dir) return table
  const file = path.join(path.resolve(dir), FILE)
  if (fs.existsSync(file)) table = JSON.parse(fs.readFileSync(file, 'utf8'))
  return table
}

export function cliText(key) {
  const t = load()
  return t && Object.prototype.hasOwnProperty.call(t, key) && typeof t[key] === 'string' ? t[key] : undefined
}
