// Minimal Chrome DevTools Protocol driver for the Tauri/WebView2 windows (no dependencies).
// Usage:
//   node cdp.mjs targets
//   node cdp.mjs shot  <urlSubstr|index> <out.png>
//   node cdp.mjs eval  <urlSubstr|index> "<js expression>"
//   node cdp.mjs click <urlSubstr|index> "<css selector>" [text-contains]
//   node cdp.mjs type  <urlSubstr|index> "<text>"
//   node cdp.mjs key   <urlSubstr|index> <KeyName>
import fs from 'node:fs'

const PORT = process.env.CDP_PORT || '9333'
const base = `http://127.0.0.1:${PORT}`

async function targets() {
  const res = await fetch(`${base}/json/list`)
  return (await res.json()).filter((t) => t.type === 'page')
}

async function pick(sel) {
  const list = await targets()
  if (/^\d+$/.test(sel)) return list[Number(sel)]
  return list.find((t) => t.url.includes(sel) || (t.title || '').includes(sel))
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    }
    ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')))
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const myId = ++id
            pending.set(myId, { res, rej })
            ws.send(JSON.stringify({ id: myId, method, params }))
          }),
        close: () => ws.close(),
      })
  })
}

const [cmd, sel, ...rest] = process.argv.slice(2)

if (cmd === 'targets') {
  const list = await targets()
  list.forEach((t, i) => console.log(i, t.title, '|', t.url))
  process.exit(0)
}

const target = await pick(sel)
if (!target) {
  console.error('no target matches', sel)
  process.exit(2)
}
const cdp = await connect(target)

try {
  if (cmd === 'shot') {
    const out = rest[0]
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(out, Buffer.from(data, 'base64'))
    console.log('saved', out, Math.round(data.length * 0.75), 'bytes')
  } else if (cmd === 'eval') {
    const r = await cdp.send('Runtime.evaluate', { expression: rest[0], returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(r.result?.value ?? r.result ?? r, null, 1))
  } else if (cmd === 'click') {
    const [selector, contains] = rest
    const expr = `(() => { const els=[...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${contains ? `els.find(e=>e.textContent.includes(${JSON.stringify(contains)}))` : 'els[0]'}; if(!el) return 'NOT FOUND (' + els.length + ' candidates)'; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:(el.textContent||'').slice(0,40)}; })()`
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    const pos = r.result.value
    if (typeof pos === 'string') {
      console.log(pos)
      process.exitCode = 3
    } else {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      }
      console.log('clicked', JSON.stringify(pos))
    }
  } else if (cmd === 'type') {
    await cdp.send('Input.insertText', { text: rest[0] })
    console.log('typed', rest[0].length, 'chars')
  } else if (cmd === 'key') {
    const key = rest[0]
    const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Tab: 9, Home: 36, End: 35, ' ': 32 }
    const vk = codes[key] || key.toUpperCase().charCodeAt(0)
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk })
    console.log('key', key)
  } else {
    console.error('unknown command', cmd)
    process.exitCode = 1
  }
} finally {
  cdp.close()
}
