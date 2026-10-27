import net from 'node:net'
import tls from 'node:tls'

const TIMEOUT_MS = 20000

export class MailNotConfigured extends Error {
  constructor() {
    super('setup email is not configured: set CASEY_SMTP_HOST and CASEY_SMTP_FROM')
    this.code = 'smtp_not_configured'
  }
}

export function smtpConfig(env = process.env) {
  const host = String(env.CASEY_SMTP_HOST || '').trim()
  const from = String(env.CASEY_SMTP_FROM || '').trim()
  if (!host || !from) throw new MailNotConfigured()
  return {
    host,
    port: Number(env.CASEY_SMTP_PORT) || 587,
    from,
    user: String(env.CASEY_SMTP_USER || ''),
    pass: String(env.CASEY_SMTP_PASSWORD || ''),
  }
}

const envelopeAddress = (from) => (/<([^>]+)>/.exec(from)?.[1] || from).trim()

function replyReader(sock) {
  let buf = ''
  let lines = []
  const replies = []
  let failure = null
  let wake = null
  const settle = () => { const w = wake; wake = null; w?.() }
  sock.setEncoding('utf8')
  sock.setTimeout(TIMEOUT_MS)
  sock.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      lines.push(line)
      if (line[3] !== '-') {
        replies.push({ code: Number(line.slice(0, 3)), lines: lines.map(l => l.slice(4)) })
        lines = []
      }
    }
    settle()
  })
  const fail = (err) => { failure = failure || err; settle() }
  sock.on('error', fail)
  sock.on('timeout', () => fail(new Error('SMTP server did not answer in time')))
  sock.on('close', () => fail(new Error('SMTP connection closed')))
  return {
    write: (line) => sock.write(line + '\r\n'),
    async next() {
      for (;;) {
        if (replies.length) return replies.shift()
        if (failure) throw failure
        await new Promise(r => { wake = r })
      }
    },
  }
}

async function step(io, name, line, ok) {
  if (line !== null) io.write(line)
  const reply = await io.next()
  if (!ok.includes(reply.code)) throw new Error(`SMTP ${name} refused with code ${reply.code}`)
  return reply
}

function composeMessage(from, { to, subject, text }) {
  const body = Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n')
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
  ].join('\r\n')
  return `${head}\r\n${body}`
}

export async function sendMail(message, env = process.env) {
  const cfg = smtpConfig(env)
  const implicitTls = cfg.port === 465
  let sock = implicitTls
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, minVersion: 'TLSv1.2' })
    : net.connect({ host: cfg.host, port: cfg.port })
  let io = replyReader(sock)
  try {
    await step(io, 'greeting', null, [220])
    let ehlo = await step(io, 'EHLO', 'EHLO casey', [250])
    if (!implicitTls && ehlo.lines.some(l => /^STARTTLS$/i.test(l))) {
      await step(io, 'STARTTLS', 'STARTTLS', [220])
      sock = tls.connect({ socket: sock, servername: cfg.host, minVersion: 'TLSv1.2' })
      io = replyReader(sock)
      ehlo = await step(io, 'EHLO', 'EHLO casey', [250])
    }
    if (cfg.user) {
      if (!sock.encrypted) throw new Error('refusing to send SMTP credentials without TLS')
      if (!ehlo.lines.some(l => /^AUTH\b/i.test(l))) throw new Error('SMTP server offers no AUTH')
      const credential = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')
      await step(io, 'AUTH', `AUTH PLAIN ${credential}`, [235])
    }
    await step(io, 'MAIL FROM', `MAIL FROM:<${envelopeAddress(cfg.from)}>`, [250])
    await step(io, 'RCPT TO', `RCPT TO:<${message.to}>`, [250, 251])
    await step(io, 'DATA', 'DATA', [354])
    await step(io, 'message', composeMessage(cfg.from, message) + '.', [250])
    io.write('QUIT')
  } finally {
    sock.destroy()
  }
}
