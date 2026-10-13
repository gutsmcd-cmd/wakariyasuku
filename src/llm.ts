// On-device small instruct model (transformers.js; WebGPU with WASM fallback), downloaded once and cached.
// Same model ids/dtypes as まとめ屋 (u74-summarize) so the cached files are shared on the github.io origin.
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }
export type Engine = 'small' | 'better'

export const MODELS = {
  small: { id: 'onnx-community/Qwen2.5-0.5B-Instruct', gpuDtype: 'q4f16', cpuDtype: 'q8', gpuMB: 483, cpuMB: 512 },
  better: { id: 'onnx-community/Qwen2.5-1.5B-Instruct', gpuDtype: 'q4f16', cpuDtype: 'q4f16', gpuMB: 1222, cpuMB: 1222 },
} as const

export const isMock = new URLSearchParams(location.search).has('mock')

export async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return !!gpu && !!(await gpu.requestAdapter())
  } catch { return false }
}

let worker: Worker | null = null
let seq = 0
const waits = new Map<number, { onToken?: (t: string) => void; resolve: (s: string) => void; reject: (e: Error) => void }>()
let loadP: Promise<void> | null = null
let loadKey = ''
let mockStop = false

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const d = e.data
    const w = d.id != null ? waits.get(d.id) : undefined
    if (d.type === 'token') w?.onToken?.(d.text)
    else if (d.type === 'done') { w?.resolve(d.text); waits.delete(d.id) }
    else if (d.type === 'error' && w) { w.reject(new Error(d.message)); waits.delete(d.id) }
  }
  return worker
}

export interface LoadInfo { device: 'webgpu' | 'wasm' | 'mock'; sizeMB: number }

export async function loadModel(engine: Engine, onProgress: (frac: number, loadedMB: number, totalMB: number) => void): Promise<LoadInfo> {
  if (isMock) { onProgress(1, 1, 1); return { device: 'mock', sizeMB: 0 } }
  const gpu = await hasWebGPU()
  const spec = MODELS[engine]
  const device = gpu ? 'webgpu' : 'wasm'
  const dtype = gpu ? spec.gpuDtype : spec.cpuDtype
  const key = `${spec.id}|${device}|${dtype}`
  const info: LoadInfo = { device, sizeMB: gpu ? spec.gpuMB : spec.cpuMB }
  if (loadP && loadKey === key) { await loadP; return info }
  loadKey = key
  const w = getWorker()
  loadP = new Promise<void>((resolve, reject) => {
    const h = (e: MessageEvent) => {
      const d = e.data
      if (d.type === 'progress' && d.total) onProgress(d.loaded / d.total, d.loaded / 1e6, d.total / 1e6)
      else if (d.type === 'ready') { w.removeEventListener('message', h); resolve() }
      else if (d.type === 'error' && d.id == null) { w.removeEventListener('message', h); loadP = null; reject(new Error(d.message)) }
    }
    w.addEventListener('message', h)
    w.postMessage({ type: 'load', model: spec.id, device, dtype })
  })
  await loadP
  return info
}

/** Stop the current answer. While the model is still downloading/loading we have to throw the worker away. */
export function cancel(loading: boolean) {
  mockStop = true
  if (!worker) return
  if (loading) {
    worker.terminate(); worker = null; loadP = null; loadKey = ''
    waits.forEach(w => w.reject(new Error('stopped'))); waits.clear()
  } else worker.postMessage({ type: 'stop' })
}

// Deterministic fake for automated tests (?mock): streams slowly so cancel can be tested.
async function mock(messages: Msg[], onToken?: (t: string) => void): Promise<string> {
  const u = messages[messages.length - 1].content
  const hook = (window as unknown as { __mockReply?: (u: string) => string }).__mockReply
  const s = hook ? hook(u) : `MOCK[${messages[0].content.slice(0, 20)}] ` + u.replace(/\s+/g, ' ').slice(-60)
  const delay = Number(new URLSearchParams(location.search).get('mockdelay') ?? 5)
  mockStop = false
  let acc = ''
  for (const ch of s.match(/.{1,4}/gs) ?? []) {
    if (mockStop) break
    acc += ch; onToken?.(ch)
    await new Promise(r => setTimeout(r, delay))
  }
  return acc
}

export async function generate(engine: Engine, messages: Msg[], maxNewTokens: number, onToken?: (t: string) => void): Promise<string> {
  void engine
  if (isMock) return mock(messages, onToken)
  const id = ++seq
  return new Promise((resolve, reject) => {
    waits.set(id, { onToken, resolve, reject })
    getWorker().postMessage({ type: 'generate', id, messages, maxNewTokens })
  })
}
