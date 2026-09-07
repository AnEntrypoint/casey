// Casey's own tool registry, replacing freddie's pi.tools.register/
// dispatchTool/getEnabledToolSchemas (freddie's plugin-host surface was
// removed in a later upstream rewrite -- see AGENTS.md's freddie-port PRD
// rows). Deliberately minimal: casey has one plugin root
// (plugins/case-tools/plugin.js) and three deterministically-dispatched
// media tools (never LLM-callable) -- no plugin discovery, no CC-hook
// bridge, no capability/resource enforcement, no hot-reload watcher.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const tools = new Map()

/**
 * Register a tool definition: { name, toolset, schema: {name, description, parameters}, handler: async (args, ctx) => result }
 * Second registration of the same name silently wins (matches freddie's
 * documented "second registration wins, no cross-root uniqueness check").
 */
export function registerTool(tool) {
  tools.set(tool.name, tool)
}

export function listTools() {
  return [...tools.values()]
}

/**
 * enabledToolsets: array of toolset category names (matched against tool.toolset).
 * disabledToolsets: array of tool NAMES (not toolset categories) -- matches
 * freddie's own quirk, documented in AGENTS.md's pi tool surface section.
 */
export function getEnabledToolSchemas({ enabledToolsets = [], disabledToolsets = [] } = {}) {
  const enabledSet = new Set(enabledToolsets)
  const disabledSet = new Set(disabledToolsets)
  return listTools()
    .filter(t => enabledSet.has(t.toolset || 'core') && !disabledSet.has(t.name))
    .map(t => t.schema)
}

/**
 * Direct (non-LLM-loop) dispatch by tool name -- used only for casey's own
 * deterministically-invoked media tools (transcription/vision/tts), which
 * are never registered into the 'cases' toolset and never agent-callable.
 */
export async function dispatchTool(name, args, ctx = {}) {
  const tool = tools.get(name)
  if (!tool) return JSON.stringify({ error: `unknown tool: ${name}` })
  try {
    return await tool.handler(args, ctx)
  } catch (e) {
    return JSON.stringify({ error: String(e?.message || e), tool: name })
  }
}

let _booted = false

/**
 * Scan the given plugin-root directories for plugin.js files and register
 * their tools. Mirrors freddie's bootHost() plugin-discovery contract
 * ({name, surfaces, register({pi})}) narrowly: only pi.tools.register is
 * supported (casey never used any other PI_VERB).
 */
export async function bootHost(roots = []) {
  if (_booted) return
  _booted = true
  const pi = { tools: { register: registerTool } }
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pluginFile = path.join(root, entry.name, 'plugin.js')
      if (!fs.existsSync(pluginFile)) continue
      const mod = await import(pathToFileURL(pluginFile).href)
      const plugin = mod.default
      if (!plugin || typeof plugin.register !== 'function') continue
      await plugin.register({ pi })
    }
  }
}

export function resetToolRegistryForTests() {
  tools.clear()
  _booted = false
}
