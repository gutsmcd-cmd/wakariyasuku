import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { createWorker, type Worker as TWorker } from 'tesseract.js'
import { dict, type Lang, type Dict } from './i18n'
import * as db from './db'
import { hasWebGPU, isMock, loadModel, cancel, MODELS, type Engine } from './llm'
import { rewrite, detectLang, MODES, type Mode } from './rewrite'

registerSW({ immediate: true })
void db.askPersist()

interface Entry { id: string; created: number; mode: Mode; input: string; output: string; ms: number; device: string }

const S = {
  lang: 'ja' as Lang,
  mode: 'simple' as Mode,
  engine: 'small' as Engine,
  gpu: false,
  input: '',
  output: '',
  meta: '',
  busy: false,
  loading: false,
  stop: false,
}
const T = (): Dict => dict[S.lang]
const app = document.getElementById('app')!
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'testid') e.dataset.testid = String(v)
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v
    else e.setAttribute(k, String(v))
  }
  for (const c of kids) if (c) e.append(c)
  return e
}
const toast = (msg: string) => {
  const t = h('div', { className: 'toast', testid: 'toast' }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), 2200)
}
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

// ---------- OCR (Japanese + English, on device) ----------
let ocrWorker: Promise<TWorker> | null = null
let ocrProg: (s: string, p: number) => void = () => {}
function getOcr() {
  if (!ocrWorker) {
    const base = new URL('./tesseract/', location.href).href
    ocrWorker = createWorker(['jpn', 'eng'], 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => ocrProg(m.status, m.progress),
    })
    ocrWorker.catch(() => { ocrWorker = null })
  }
  return ocrWorker
}

/** Tesseract puts spaces between Japanese characters; remove those, keep spaces in English. */
export function tidyOcr(s: string): string {
  const J = '[\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]'
  return s
    .replace(new RegExp(`(${J}) +(?=${J})`, 'g'), '$1')
    .replace(new RegExp(`(${J}) +(?=[0-9])|([0-9]) +(?=${J})`, 'g'), '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fileToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c
  } finally { URL.revokeObjectURL(url) }
}

async function readPhoto(f: Blob) {
  const t = T()
  const first = !(await db.get('kv', 'ocrReady'))
  setStatus(first ? t.prepOcr : t.reading)
  ocrProg = (s, p) => { if (/recogniz/.test(s)) setStatus(t.reading, Math.round(p * 100) + '%') }
  try {
    const c = await fileToCanvas(f)
    const wk = await getOcr()
    await wk.setParameters({ tessedit_pageseg_mode: '3' as never, preserve_interword_spaces: '1' })
    const t0 = performance.now()
    const { data } = await wk.recognize(c)
    ;(window as unknown as Record<string, unknown>).__ocrMs = performance.now() - t0
    await db.put('kv', 'ocrReady', true)
    const text = tidyOcr(data.text ?? '')
    setStatus('')
    if (!text) { toast(t.noText); return }
    S.input = S.input.trim() ? S.input.trim() + '\n\n' + text : text
    const ta = $('input') as HTMLTextAreaElement | null
    if (ta) { ta.value = S.input; updCount() }
    toast(t.ocrDone)
  } catch (e) {
    console.warn(e); setStatus(''); alert(t.ocrFail)
  }
}

// ---------- Status ----------
function setStatus(msg: string, sub = '') {
  const el = $('status')
  if (!el) return
  el.hidden = !msg
  el.replaceChildren(h('div', { className: 'spin' }), h('div', {}, msg), ...(sub ? [h('div', { className: 'small' }, sub)] : []))
}
function updCount() {
  const c = $('count')
  if (c) c.textContent = T().chars(S.input.length)
  const tr = $('trdir')
  if (tr) tr.textContent = S.mode === 'translate' && S.input.trim() ? (detectLang(S.input) === 'ja' ? T().toEn : T().toJa) : ''
}

// ---------- Run ----------
async function go() {
  const t = T()
  if (S.busy) return
  if (!S.input.trim()) { toast(t.empty); return }
  S.busy = true; S.stop = false; S.output = ''; S.meta = ''
  paintRun()
  const out = $('output')!
  const t0 = performance.now()
  let device = 'mock'
  try {
    const cached = isMock || (await db.get('kv', 'model:' + S.engine))
    S.loading = true
    setStatus(cached ? t.loading : t.firstDl(MODELS[S.engine].cpuMB), '')
    const info = await loadModel(S.engine, (f, a, b) => setStatus(t.dl(Math.round(f * 100), a, b), t.firstDl(Math.round(b))))
    S.loading = false
    device = info.device
    await db.put('kv', 'model:' + S.engine, true)
    if (S.stop) throw new Error('stopped')
    setStatus(t.working(1, 1), t.speedNote)
    const g0 = performance.now()
    const res = await rewrite(S.input, S.mode, S.engine,
      (s) => { S.output = s; out.textContent = s },
      (p) => setStatus(t.working(p.part, p.parts), t.speed((p.tokens / Math.max(0.001, p.ms / 1000)).toFixed(1), Math.round((performance.now() - t0) / 1000))),
      () => S.stop)
    S.output = res
    out.textContent = res
    const ms = performance.now() - t0
    ;(window as unknown as Record<string, unknown>).__last = { ms, genMs: performance.now() - g0, device }
    S.meta = S.stop ? t.stopped : t.done(Math.round(ms / 100) / 10, device)
    if (res) {
      const e: Entry = { id: Date.now().toString(36), created: Date.now(), mode: S.mode, input: S.input, output: res, ms, device }
      await db.put('hist', e.id, e)
    }
  } catch (e) {
    S.loading = false
    if (S.stop || /stopped/.test(String(e))) S.meta = t.stopped
    else { console.warn(e); S.meta = t.fail + ' (' + String((e as Error).message ?? e).slice(0, 120) + ')' }
  } finally {
    S.busy = false
    setStatus('')
    paintRun()
    void paintHistory()
  }
}

function paintRun() {
  const t = T()
  const goB = $('go'), stopB = $('stop'), meta = $('meta'), res = $('resultbox')
  if (goB) (goB as HTMLButtonElement).disabled = S.busy
  if (stopB) stopB.hidden = !S.busy
  if (meta) meta.textContent = S.meta
  if (res) res.hidden = !S.busy && !S.output
  const acts = $('actions')
  if (acts) acts.hidden = S.busy || !S.output
  void t
}

// ---------- Views ----------
function fileInput(capture: boolean) {
  const i = h('input', { type: 'file', accept: 'image/*', hidden: true }) as HTMLInputElement
  if (capture) i.setAttribute('capture', 'environment')
  i.onchange = () => { const f = i.files?.[0]; if (f) void readPhoto(f); i.value = '' }
  return i
}

async function paintHistory() {
  const t = T()
  const list = $('history')
  if (!list) return
  const items = (await db.all<Entry>('hist')).sort((a, b) => b.created - a.created)
  list.replaceChildren()
  if (!items.length) list.append(h('p', { className: 'small' }, t.none))
  for (const e of items) {
    list.append(h('div', { className: 'hrow' },
      h('div', { className: 'hmeta', onclick: () => { S.input = e.input; S.output = e.output; S.mode = e.mode; S.meta = ''; render(); scrollTo({ top: 0, behavior: 'smooth' }) } },
        h('div', { className: 'hex' }, e.output.replace(/\s+/g, ' ').slice(0, 90)),
        h('div', { className: 'small' }, t.modes[e.mode], ' · ', new Date(e.created).toLocaleString(S.lang === 'ja' ? 'ja-JP' : 'en-GB'))),
      h('button', { className: 'icon sm danger', 'aria-label': t.del, onclick: async () => { if (confirm(t.delQ)) { await db.del('hist', e.id); void paintHistory() } } }, '🗑')))
  }
}

function render() {
  const t = T()
  document.documentElement.lang = S.lang
  const shoot = fileInput(true), pick = fileInput(false)
  const ta = h('textarea', { testid: 'input', placeholder: t.placeholder, rows: 8, value: S.input,
    oninput: () => { S.input = ta.value; updCount() } }) as HTMLTextAreaElement
  const modes: HTMLElement = h('div', { className: 'chips', role: 'radiogroup', 'aria-label': t.modeLabel },
    ...MODES.map((m) => h('button', { className: S.mode === m ? 'on' : '', role: 'radio', 'aria-checked': String(S.mode === m), testid: 'mode-' + m,
      onclick: async (ev: Event) => { S.mode = m; for (const b of modes.children) { b.classList.toggle('on', b === ev.currentTarget); b.setAttribute('aria-checked', String(b === ev.currentTarget)) } updCount(); await db.put('kv', 'mode', m) } }, t.modes[m])))
  const engines = h('div', { className: 'seg' },
    ...(['small', 'better'] as Engine[]).map((e) => h('button', { className: S.engine === e ? 'on' : '', testid: 'engine-' + e, disabled: e === 'better' && !S.gpu && !isMock,
      onclick: async () => { S.engine = e; render(); await db.put('kv', 'engine', e) } }, t[e])))
  const out = h('div', { className: 'out', testid: 'output', 'aria-live': 'polite' }, S.output)
  app.replaceChildren(
    h('div', { className: 'top' },
      h('h1', {}, t.app),
      h('button', { className: 'ghost', testid: 'lang', onclick: async () => { S.lang = S.lang === 'ja' ? 'en' : 'ja'; render(); await db.put('kv', 'lang', S.lang) } }, t.toggle)),
    h('p', { className: 'lead' }, t.lead),
    h('div', { className: 'inrow' },
      h('button', { testid: 'paste', onclick: async () => { try { const s = await navigator.clipboard.readText(); if (s) { S.input = s; ta.value = s; updCount() } } catch { ta.focus() } } }, t.paste),
      h('button', { testid: 'shoot', onclick: () => shoot.click() }, t.shoot),
      h('button', { testid: 'pick', onclick: () => pick.click() }, t.pick),
      shoot, pick),
    ta,
    h('div', { className: 'row' }, h('span', { className: 'small', testid: 'count' }), h('button', { className: 'tiny ghost', onclick: () => { S.input = ''; ta.value = ''; updCount() } }, t.clear)),
    h('h2', {}, t.modeLabel), modes,
    h('div', { className: 'small trdir', testid: 'trdir' }),
    h('div', { className: 'gorow' },
      h('button', { className: 'big primary', testid: 'go', onclick: go }, t.go),
      h('button', { className: 'big danger', testid: 'stop', hidden: true, onclick: () => { S.stop = true; cancel(S.loading) } }, t.stop)),
    h('div', { className: 'status', testid: 'status', hidden: true }),
    h('div', { className: 'resultbox', testid: 'resultbox', hidden: !S.output },
      h('h2', {}, t.result), out,
      h('div', { className: 'small', testid: 'meta' }, S.meta),
      h('div', { className: 'acts', testid: 'actions', hidden: !S.output },
        h('button', { testid: 'copy', onclick: async () => { try { await navigator.clipboard.writeText(S.output); toast(t.copied) } catch { prompt('', S.output) } } }, t.copy),
        h('button', { testid: 'share', onclick: async () => { if (navigator.share) { try { await navigator.share({ text: S.output }) } catch { /* cancelled */ } } else { try { await navigator.clipboard.writeText(S.output); toast(t.copied) } catch { /* */ } } } }, t.share),
        h('button', { testid: 'again', onclick: () => { S.input = S.output; S.output = ''; S.meta = ''; render() } }, t.useAsInput))),
    h('p', { className: 'honest' }, t.honest),
    h('div', { className: 'row' }, h('span', { className: 'small' }, t.engineLabel), engines),
    ...(!S.gpu && !isMock ? [h('p', { className: 'small' }, t.betterNeedsGpu)] : []),
    h('h2', {}, t.history), h('div', { className: 'hist', testid: 'history' }),
    h('p', { className: 'foot' }, t.foot), h('p', { className: 'foot' }, t.credit))
  updCount()
  paintRun()
  void paintHistory()
}

async function init() {
  S.lang = (await db.get<Lang>('kv', 'lang')) ?? (navigator.language.startsWith('ja') ? 'ja' : 'ja')
  S.mode = (await db.get<Mode>('kv', 'mode')) ?? 'simple'
  S.gpu = await hasWebGPU()
  const e = await db.get<Engine>('kv', 'engine')
  S.engine = e === 'better' && (S.gpu || isMock) ? 'better' : 'small'
  // Web Share Target (GET): ./?title=…&text=…&url=…
  const q = new URLSearchParams(location.search)
  const shared = [q.get('title'), q.get('text'), q.get('url')].filter((x) => x && x.trim()).join('\n')
  if (shared) {
    S.input = shared
    const keep = new URLSearchParams(); if (isMock) keep.set('mock', '')
    if (q.get('mockdelay')) keep.set('mockdelay', q.get('mockdelay')!)
    history.replaceState(null, '', location.pathname + (keep.toString() ? '?' + keep.toString().replace(/=(&|$)/g, '$1') : ''))
  }
  render()
}
void init()
;(window as unknown as Record<string, unknown>).__wk = { S, tidyOcr, detectLang }
