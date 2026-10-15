// Fix 1A probe: does the ChatGPT transcription endpoint (the one
// CloudTranscriber::transcribe calls) challenge a plain, honest Bitbots client?
//
// Reads $CODEX_HOME/auth.json (default ~/.codex/auth.json) READ-ONLY, sends one
// 1-second silent 16 kHz mono PCM16 WAV exactly the way the Rust client does,
// and prints ONLY the allowed fields as one JSON object:
//   status, header names (not values), cf-mitigated, content-type, server,
//   body length, whether the body is JSON with a `text` key, and non-secret
//   facts about the auth file (auth_mode, account-id presence, token expiry).
// It never prints the token, any request header, or any response body.
//
// It identifies as Bitbots and does not imitate Codex, a browser, or any other
// client. Like bb (get-bb/bb, provider-codex/src/ai/chatgpt-fetch.ts) it keeps the
// Cloudflare cookies from a challenged response (names only are printed) and
// sends the request once more carrying them. It uses Node's own fetch, so
// comparing its result with the Rust client's isolates the network stack.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const MODEL = 'gpt-transcribe'
const SAMPLE_RATE = 16000
const USER_AGENT = 'bloblex-desktop/0.1.0-beta.19'
const TIMEOUT_MS = 65000

function authPath() {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
  if (home) return path.join(home, 'auth.json')
  return path.join(os.homedir(), '.codex', 'auth.json')
}

function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

function accountIdFromClaims(claims) {
  const auth = claims && claims['https://api.openai.com/auth']
  const id = auth && auth.chatgpt_account_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function fedrampFromClaims(claims) {
  const auth = claims && claims['https://api.openai.com/auth']
  return Boolean(auth && auth.chatgpt_account_is_fedramp)
}

function loadAuth() {
  const file = authPath()
  const raw = fs.readFileSync(file, 'utf8')
  const value = JSON.parse(raw)
  const tokens = value.tokens || {}
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : ''
  const accessClaims = accessToken ? decodeJwtClaims(accessToken) : null
  const idClaims = typeof tokens.id_token === 'string' ? decodeJwtClaims(tokens.id_token) : null
  const explicit = typeof tokens.account_id === 'string' && tokens.account_id.trim() ? tokens.account_id.trim() : null
  const accountId = explicit || accountIdFromClaims(accessClaims) || accountIdFromClaims(idClaims) || null
  const fedramp = fedrampFromClaims(accessClaims) || fedrampFromClaims(idClaims)
  const exp = accessClaims && typeof accessClaims.exp === 'number' ? accessClaims.exp : null
  return {
    file,
    authMode: typeof value.auth_mode === 'string' ? value.auth_mode : null,
    accessToken,
    accountId,
    accountIdPresent: accountId !== null,
    fedramp,
    expired: exp !== null ? exp * 1000 <= Date.now() : null,
  }
}

function silentWav(seconds) {
  const samples = SAMPLE_RATE * seconds
  const dataLen = samples * 2
  const wav = Buffer.alloc(44 + dataLen)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataLen, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataLen, 40)
  return wav
}

function multipart(boundary, wav, model) {
  const parts = []
  parts.push(Buffer.from(`--${boundary}\r\n`))
  parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n'))
  parts.push(Buffer.from('Content-Type: audio/wav\r\n\r\n'))
  parts.push(wav)
  parts.push(Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}\r\n`))
  parts.push(Buffer.from('Content-Disposition: form-data; name="model"\r\n\r\n'))
  parts.push(Buffer.from(model))
  parts.push(Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

async function probe(auth) {
  const boundary = `----bloblex-${Date.now().toString(16).padStart(32, '0')}`
  const wav = silentWav(1)
  const body = multipart(boundary, wav, MODEL)
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'User-Agent': USER_AGENT,
    originator: 'bloblex',
    Authorization: `Bearer ${auth.accessToken}`,
  }
  if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId
  if (auth.fedramp) headers['X-OpenAI-Fedramp'] = 'true'

  const ALLOWED = new Set(['__cf_bm', '__cflb', '__cfruid', '__cfseq', '__cfwaitingroom', '_cfuvid', 'cf_clearance', 'cf_ob_info', 'cf_use_ob'])
  const jar = new Map()
  const keep = (res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0].trim()
      const name = pair.split('=')[0].trim()
      if (ALLOWED.has(name) || name.startsWith('cf_chl_')) jar.set(name, pair)
    }
  }
  const once = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const sent = { ...headers }
      if (jar.size) sent.Cookie = [...jar.values()].join('; ')
      const res = await fetch('https://chatgpt.com/backend-api/transcribe', { method: 'POST', headers: sent, body, signal: controller.signal })
      keep(res)
      return res
    } finally {
      clearTimeout(timer)
    }
  }
  let response = await once()
  const attempts = [response.status]
  if (response.status === 403 && (response.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge') {
    await response.arrayBuffer()
    response = await once()
    attempts.push(response.status)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const headerNames = [...response.headers.keys()].map((name) => name.toLowerCase()).sort()
  let bodyParsesJson = false
  let bodyHasTextKey = false
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    bodyParsesJson = true
    bodyHasTextKey = parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string'
  } catch {
    bodyParsesJson = false
  }

  return {
    status: response.status,
    attempts,
    cloudflareCookieNames: [...jar.keys()],
    headerNames,
    cfMitigated: response.headers.get('cf-mitigated'),
    contentType: response.headers.get('content-type'),
    server: response.headers.get('server'),
    bodyLength: bytes.length,
    bodyParsesJson,
    bodyHasTextKey,
  }
}

function codexVersion() {
  try {
    return execFileSync('codex', ['--version'], { encoding: 'utf8', shell: true }).trim() || null
  } catch {
    return null
  }
}

const out = { probe: 'cloud-dictation', model: MODEL, url: 'https://chatgpt.com/backend-api/transcribe' }
try {
  const auth = loadAuth()
  out.auth = {
    path: auth.file,
    authMode: auth.authMode,
    accountIdPresent: auth.accountIdPresent,
    accessTokenExpired: auth.expired,
    codexCliVersion: codexVersion(),
  }
  const result = await probe(auth)
  Object.assign(out, result)
} catch (error) {
  out.error = error && error.name ? String(error.name) : 'probe-failed'
  out.errorMessage = error && error.message ? redact(error.message) : null
}

function redact(message) {
  return String(message)
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>')
}

console.log(JSON.stringify(out, null, 2))
