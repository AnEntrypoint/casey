import { vocabText } from './config-loader.js'
import fs from 'node:fs'
import path from 'node:path'
import { defTool, str } from './case-tools-shared.js'
import { parseReport, tagList } from './timestamp.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { findCase, deskAuthorityOn, actorData, NOT_ASSIGNED } from './case-tools-team-shared.js'
import { caseyText } from './deployment-text.js';

const MAX_PHOTOS = 3
const NO_SUCH = { error: caseyText("src/case-tools-team-photos.js#0") }
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const SAVED_PATH = /\(saved: (media\/[^)\s]+)\)/g

export function storedPhotoPaths(caseRow) {
  const text = String(parseReport(caseRow).photos || '')
  const paths = []
  for (const m of text.matchAll(SAVED_PATH)) {
    const ext = path.extname(m[1]).slice(1).toLowerCase()
    if (IMAGE_MIME[ext] && !m[1].includes('..') && !paths.includes(m[1])) paths.push(m[1])
  }
  return paths
}

const takenOn = (relPath) => {
  const ms = Number(path.basename(relPath).split('-')[0])
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : ''
}

export function buildTeamPhotoTools(store) {
  return [
    defTool('case_photos', 'cases',
      caseyText("src/case-tools-team-photos.js#1", [MAX_PHOTOS, REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-team-photos.js#s0")), count: { type: 'number', description: caseyText("src/case-tools-team-photos.js#s1", [MAX_PHOTOS]), default: MAX_PHOTOS } }, required: ['case'] },
      async ({ case: ref, count = MAX_PHOTOS }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (!deskAuthorityOn(ctx, c)) return NOT_ASSIGNED
        if (typeof ctx?.sendImage !== 'function' || !ctx.canSendImage?.(ctx.channel)) return { error: caseyText("src/case-tools-team-photos.js#2") }
        const mine = ctx.activeCaseId ? await store().getCase(ctx.activeCaseId) : null
        if (!mine) return { error: vocabText('ui.photos_send_no_chat', caseyText("src/case-tools-team-photos.js#3")) }
        if (tagList(mine).includes(OPTED_OUT_TAG)) return { error: caseyText("src/case-tools-team-photos.js#4") }
        const { withinSessionWindow, sessionWindowHours } = await import('./hooks/notifiers.js')
        const recent = await store().listEventsPage(mine.id, { limit: 25, offset: 0 })
        if (!withinSessionWindow(mine, recent)) return { error: caseyText("src/case-tools-team-photos.js#5", [sessionWindowHours()]) }

        const stored = storedPhotoPaths(c)
        if (!stored.length) return { ok: true, ref: c.ref, sent: 0, stored: 0, note: caseyText("src/case-tools-team-photos.js#s2") }
        const n = Math.min(Math.max(Math.floor(Number(count)) || MAX_PHOTOS, 1), MAX_PHOTOS)
        const chosen = stored.slice(-n).reverse()
        const mediaRoot = path.resolve(store().dataDir, 'media')
        let sent = 0
        const failed = []
        for (const [i, rel] of chosen.entries()) {
          const full = path.resolve(store().dataDir, rel)
          const date = takenOn(rel)
          try {
            if (!full.startsWith(mediaRoot + path.sep)) throw new Error('photo path is outside the media store')
            await ctx.sendImage(mine, { buffer: fs.readFileSync(full), mime: IMAGE_MIME[path.extname(rel).slice(1).toLowerCase()], caption: caseyText("src/case-tools-team-photos.js#s3", [c.ref, i + 1, chosen.length, date ? `, taken ${date}` : '']) })
            sent += 1
          } catch (e) { failed.push(`${path.basename(rel)}: ${String(e.message).slice(0, 160)}`) }
        }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-team-photos.js#s4", [staffLabel(ctx.contact), sent, chosen.length, failed.length ? ` (${failed.length} failed)` : '']), data: actorData(ctx, { photos_viewed: true }) })
        return { ok: sent > 0, ref: c.ref, sent, stored: stored.length, ...(failed.length ? { failed, error: caseyText("src/case-tools-team-photos.js#s5", [failed.length]) } : {}) }
      }),
  ]
}
