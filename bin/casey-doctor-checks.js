import path from 'node:path'
import fs, { existsSync } from 'node:fs'
import os from 'node:os'
import { bold, dim, green, red, cyan, ok, bad, warn, hasCreds } from './casey-cli-ui.js'
import { createCaseStore } from '../src/case-store.js'
import { caseyText } from '../src/deployment-text.js';

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
    console.log(dim(caseyText("bin/casey-doctor-checks.js#w0")))
    return 0
  }
  const { probeMeta } = await import('../src/meta-probe.js')
  console.log(bold('\nWhatsApp / Meta') + dim(caseyText("bin/casey-doctor-checks.js#w1")))
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
  console.log(bold(caseyText("bin/casey-doctor-checks.js#w2")))
  const { rows } = await checkRoleSetup(dbFile, { openStatuses })
  return render(rows)
}

export async function runVocabularyChecks() {
  const { loadDomainConfig } = await import('../src/config-loader.js')
  const { vocabulary: v, dir } = loadDomainConfig()
  console.log(bold('\nVocabulary') + dim(caseyText("bin/casey-doctor-checks.js#w3")))
  const out = []
  const shown = (keys) => keys.slice(0, 30).join(', ') + (keys.length > 30 ? caseyText("bin/casey-doctor-checks.js#w4", [keys.length - 30]) : '')
  if (!v.hasFile) out.push({ level: 'warn', text: caseyText("bin/casey-doctor-checks.js#w5", [dir]), fix: caseyText("bin/casey-doctor-checks.js#w6") })
  else out.push({ level: 'ok', text: caseyText("bin/casey-doctor-checks.js#w7", [Object.keys(v.words).length, v.file]) })
  if (v.missing.length) out.push({ level: 'warn', text: caseyText("bin/casey-doctor-checks.js#w8", [v.missing.length, shown(v.missing)]), fix: caseyText("bin/casey-doctor-checks.js#w9") })
  if (v.invalid.length) out.push({ level: 'warn', text: caseyText("bin/casey-doctor-checks.js#w10", [v.invalid.length, shown(v.invalid)]), fix: caseyText("bin/casey-doctor-checks.js#w11") })
  if (v.unknown.length) out.push({ level: 'warn', text: caseyText("bin/casey-doctor-checks.js#w12", [v.unknown.length, shown(v.unknown)]), fix: caseyText("bin/casey-doctor-checks.js#w13") })
  const { hiddenFieldsReport } = await import('../src/store/report-shape.js')
  for (const r of hiddenFieldsReport()) out.push(r)
  return render(out)
}

export async function runDataProcessorChecks() {
  const { describeProcessors, auditFile } = await import('../src/llm-data-policy.js')
  const { mode, rows } = describeProcessors(process.env)
  console.log(bold(caseyText("bin/casey-doctor-checks.js#w14")) + dim(caseyText("bin/casey-doctor-checks.js#w15")))
  const out = []
  if (mode === 'allow') out.push({ level: 'warn', text: caseyText("bin/casey-doctor-checks.js#w16"), fix: caseyText("bin/casey-doctor-checks.js#w17") })
  else out.push({ level: 'ok', text: caseyText("bin/casey-doctor-checks.js#w18", [mode, mode === 'zdr' ? caseyText("bin/casey-doctor-checks.js#w19") : caseyText("bin/casey-doctor-checks.js#w20")]) })
  for (const r of rows) {
    const bad = /REFUSED|NONE/.test(r.policy)
    out.push({ level: bad && mode !== 'allow' && /^chat LLM/.test(r.processor) ? 'warn' : 'skip', text: `${r.processor}: ${r.policy} -- ${r.state}; data: ${r.data}`, ...(bad && /^chat LLM/.test(r.processor) && mode !== 'allow' ? { fix: caseyText("bin/casey-doctor-checks.js#w21") } : {}) })
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
          ? { level: left < 1 ? 'fail' : 'warn', text: caseyText("bin/casey-doctor-checks.js#w22", [left.toFixed(2), d.total_credits.toFixed(2), min]), fix: caseyText("bin/casey-doctor-checks.js#w23") }
          : { level: 'ok', text: caseyText("bin/casey-doctor-checks.js#w24", [left.toFixed(2)]) })
      }
    }
  } catch {}
  const { sttDoctorRows } = await import('../src/stt/doctor.js')
  out.push(...await sttDoctorRows({ offline: process.env.CASEY_DOCTOR_OFFLINE === '1' }))
  const af = auditFile(process.env)
  out.push({ level: 'skip', text: af ? caseyText("bin/casey-doctor-checks.js#w25", [af]) : caseyText("bin/casey-doctor-checks.js#w26") })
  const proactive = String(process.env.CASEY_PROACTIVE_SENDS || 'off').trim().toLowerCase()
  out.push({ level: 'skip', text: caseyText("bin/casey-doctor-checks.js#w27", [proactive === 'window' ? caseyText("bin/casey-doctor-checks.js#w28") : caseyText("bin/casey-doctor-checks.js#w29")]) })
  return render(out)
}
