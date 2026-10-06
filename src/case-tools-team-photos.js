import fs from 'node:fs'
import path from 'node:path'
import { defTool, str } from './case-tools-shared.js'
import { parseReport, tagList } from './timestamp.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { findCase, deskAuthorityOn, actorData, NOT_ASSIGNED } from './case-tools-team-shared.js'

const MAX_PHOTOS = 3
const NO_SUCH = { error: 'No such record. Ask for the reference again.' }
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
      `Send this team member up to ${MAX_PHOTOS} of the stored photos of ONE ${REPORT_ENTITY_LABEL} as images in this chat, newest first, each captioned with the reference. For a ${REPORT_ENTITY_LABEL} assigned to them, or one on the sign-off desk or held by nobody. Use when they ask to see the photos. Say plainly how many were sent, or that none are stored.`,
      { type: 'object', properties: { case: str('Record reference or id'), count: { type: 'number', description: `How many, 1 to ${MAX_PHOTOS}`, default: MAX_PHOTOS } }, required: ['case'] },
      async ({ case: ref, count = MAX_PHOTOS }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (!deskAuthorityOn(ctx, c)) return NOT_ASSIGNED
        if (typeof ctx?.sendImage !== 'function' || !ctx.canSendImage?.(ctx.channel)) return { error: 'Photos cannot be sent over this channel from here. Say so plainly.' }
        const mine = ctx.activeCaseId ? await store().getCase(ctx.activeCaseId) : null
        if (!mine) return { error: 'Could not tell which chat to send the photos to, so nothing was sent.' }
        if (tagList(mine).includes(OPTED_OUT_TAG)) return { error: 'Nothing was sent: this person asked us not to message them again.' }
        const { withinSessionWindow, sessionWindowHours } = await import('./hooks/notifiers.js')
        const recent = await store().listEventsPage(mine.id, { limit: 25, offset: 0 })
        if (!withinSessionWindow(mine, recent)) return { error: `Nothing was sent: this person last wrote more than ${sessionWindowHours()}h ago, outside WhatsApp's free reply window.` }

        const stored = storedPhotoPaths(c)
        if (!stored.length) return { ok: true, ref: c.ref, sent: 0, stored: 0, note: 'No photo is stored on this record.' }
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
            await ctx.sendImage(mine, { buffer: fs.readFileSync(full), mime: IMAGE_MIME[path.extname(rel).slice(1).toLowerCase()], caption: `${c.ref} photo ${i + 1} of ${chosen.length}${date ? `, taken ${date}` : ''}` })
            sent += 1
          } catch (e) { failed.push(`${path.basename(rel)}: ${String(e.message).slice(0, 160)}`) }
        }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `PHOTOS SENT to ${staffLabel(ctx.contact)}: ${sent} of ${chosen.length}${failed.length ? ` (${failed.length} failed)` : ''}`, data: actorData(ctx, { photos_viewed: true }) })
        return { ok: sent > 0, ref: c.ref, sent, stored: stored.length, ...(failed.length ? { failed, error: `${failed.length} photo(s) could not be sent` } : {}) }
      }),
  ]
}
