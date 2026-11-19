import fs from 'node:fs'
import path from 'node:path'

const FILE = 'casey-text.json'
let table = null

function load() {
  if (table) return table
  if (!process.env.CASEY_CONFIG_DIR) throw new Error('CASEY_CONFIG_DIR is required: it holds casey-text.json')
  const file = path.join(path.resolve(process.env.CASEY_CONFIG_DIR), FILE)
  table = JSON.parse(fs.readFileSync(file, 'utf8'))
  return table
}

export function caseyText(key, args) {
  const t = load()
  if (!Object.prototype.hasOwnProperty.call(t, key)) throw new Error(`${FILE} has no entry ${key}`)
  const s = t[key]
  if (!args || args.length === 0) return s
  return s.replace(/\{\$(\d+)\}/g, (_, i) => String(args[Number(i)]))
}
