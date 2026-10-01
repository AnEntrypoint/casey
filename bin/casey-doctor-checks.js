import path from 'node:path'
import fs, { existsSync } from 'node:fs'
import os from 'node:os'
import { bold, dim, green, red, cyan, ok, bad, warn, hasCreds } from './casey-cli-ui.js'
import { createCaseStore } from '../src/case-store.js'

function render(rows) {
  let problems = 0
  for (const r of rows) {
    if (r.level === 'ok') console.log(ok(r.text))
    else if (r.level === 'fail') { console.log(bad(r.text)); problems++ }
    else if (r.level === 'warn') console.log(warn(r.text))
    else console.log(dim(`  ${r.text}`))
    if (r.fix && (r.level === 'fail' || r.level === 'warn')) console.log(dim(`      fix: ${r.fix}`))
  }
  return problems
}

export async function runMetaChecks(flags = {}) {
  if (!hasCreds('whatsapp')) return 0
  if (flags['no-network'] || flags.offline || process.env.CASEY_DOCTOR_OFFLINE === '1') {
    console.log(dim('  Meta and public-URL checks skipped (--no-network)'))
    return 0
  }
  const { probeMeta } = await import('../src/meta-probe.js')
  console.log(bold('\nWhatsApp / Meta') + dim('  (read-only GETs; nothing is changed or sent)'))
  const res = await probeMeta({})
  if (res.skipped && !res.rows.length) return 0
  return render(res.rows)
}

export async function runRoleChecks() {
  const dbFile = path.join(process.cwd(), 'data', 'db.sqlite')
  if (!existsSync(dbFile)) return 0
  const { checkRoleSetup } = await import('../src/role-health.js')
  let openStatuses = []
  try {
    const cfgFile = process.env.CASEY_CONFIG_DIR ? path.join(path.resolve(process.env.CASEY_CONFIG_DIR), 'thatcher.config.yml') : path.join(process.cwd(), 'thatcher.config.yml')
    const s = createCaseStore({ config: cfgFile }); s.validateConfig(); openStatuses = s.getOpenStatuses()
  } catch {}
  console.log(bold('\nTeam and roles'))
  const { rows } = await checkRoleSetup(dbFile, { openStatuses })
  return render(rows)
}

export async function runVocabularyChecks() {
  const { loadDomainConfig } = await import('../src/config-loader.js')
  const { vocabulary: v, dir } = loadDomainConfig()
  console.log(bold('\nVocabulary') + dim('  (the words people read; one file the team edits)'))
  const out = []
  const shown = (keys) => keys.slice(0, 30).join(', ') + (keys.length > 30 ? `, and ${keys.length - 30} more` : '')
  if (!v.hasFile) out.push({ level: 'warn', text: `no vocabulary.yml in ${dir}: every word uses the built-in default`, fix: 'copy config/default/vocabulary.yml into the config dir and edit it' })
  else out.push({ level: 'ok', text: `vocabulary: ${Object.keys(v.words).length} words in force from ${v.file}` })
  if (v.missing.length) out.push({ level: 'warn', text: `${v.missing.length} word(s) missing from vocabulary.yml (the built-in wording is used): ${shown(v.missing)}`, fix: 'add each key to vocabulary.yml; docs/vocabulary-guide.md lists what every key does' })
  if (v.invalid.length) out.push({ level: 'warn', text: `${v.invalid.length} vocabulary key(s) are blank or not plain text and were ignored: ${shown(v.invalid)}`, fix: 'give each one a line of text (bot texts may be a list of lines)' })
  if (v.unknown.length) out.push({ level: 'warn', text: `${v.unknown.length} vocabulary key(s) that nothing reads (a typo?): ${shown(v.unknown)}`, fix: 'compare the spelling with docs/vocabulary-guide.md' })
  const { hiddenFieldsReport } = await import('../src/store/report-shape.js')
  for (const r of hiddenFieldsReport()) out.push(r)
  return render(out)
}

export async function runDataProcessorChecks() {
  const { describeProcessors, auditFile } = await import('../src/llm-data-policy.js')
  const { mode, rows } = describeProcessors(process.env)
  console.log(bold('\nData processors') + dim('  (who receives personal data, and under what policy; nothing is contacted)'))
  const out = []
  if (mode === 'allow') out.push({ level: 'warn', text: 'CASEY_LLM_DATA_POLICY=allow: the no-training routing policy is OFF', fix: 'remove CASEY_LLM_DATA_POLICY (default deny) or set it to deny / zdr' })
  else out.push({ level: 'ok', text: `LLM data policy: ${mode}${mode === 'zdr' ? ' (zero-retention endpoints only)' : ' (no-training endpoints only)'}` })
  for (const r of rows) {
    const bad = /REFUSED|NONE/.test(r.policy)
    out.push({ level: bad && mode !== 'allow' && /^chat LLM/.test(r.processor) ? 'warn' : 'skip', text: `${r.processor}: ${r.policy} -- ${r.state}; data: ${r.data}`, ...(bad && /^chat LLM/.test(r.processor) && mode !== 'allow' ? { fix: 'remove this model from CASEY_LLM_MODEL (it is skipped at runtime anyway)' } : {}) })
  }
  try {
    const key = process.env.OPENROUTER_API_KEY || (() => { try { return /^OPENROUTER_API_KEY=(.+)$/m.exec(fs.readFileSync(path.join(os.homedir(), '.acptoapi', '.env'), 'utf8'))?.[1]?.trim() } catch { return '' } })()
    if (key && process.env.CASEY_DOCTOR_OFFLINE !== '1') {
      const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) })
      const d = (await r.json())?.data
      if (d && Number.isFinite(d.total_credits) && Number.isFinite(d.total_usage)) {
        const left = d.total_credits - d.total_usage
        const min = Number(process.env.CASEY_CREDIT_WARN_USD) || 3
        out.push(left < min
          ? { level: left < 1 ? 'fail' : 'warn', text: `OpenRouter balance is $${left.toFixed(2)} (of $${d.total_credits.toFixed(2)} bought): below $${min}, so the bot can start refusing replies`, fix: 'top up credits at https://openrouter.ai/credits (the key\'s own limit is separate and does not add balance)' }
          : { level: 'ok', text: `OpenRouter balance $${left.toFixed(2)} left` })
      }
    }
  } catch {}
  const af = auditFile(process.env)
  out.push({ level: 'skip', text: af ? `policy audit trail: ${af}` : 'policy audit trail is OFF (CASEY_LLM_AUDIT_FILE=0)' })
  const proactive = String(process.env.CASEY_PROACTIVE_SENDS || 'off').trim().toLowerCase()
  out.push({ level: 'skip', text: `proactive sends (bot-initiated messages): ${proactive === 'window' ? 'window (allowed inside the 24h service window)' : 'off (the bot only answers people who write to it)'}` })
  return render(out)
}
