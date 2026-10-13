// Runs the language model off the main thread.
import { pipeline, TextStreamer, InterruptableStoppingCriteria, env, type TextGenerationPipeline } from '@huggingface/transformers'

env.allowLocalModels = false
env.useBrowserCache = true

let gen: TextGenerationPipeline | null = null
let loadedKey = ''
const stopper = new InterruptableStoppingCriteria()

type Msg =
  | { type: 'load'; model: string; device: 'webgpu' | 'wasm'; dtype: string }
  | { type: 'generate'; id: number; messages: { role: string; content: string }[]; maxNewTokens: number }
  | { type: 'stop' }

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data
  if (m.type === 'stop') { stopper.interrupt(); return }
  try {
    if (m.type === 'load') {
      const key = `${m.model}|${m.device}|${m.dtype}`
      if (gen && loadedKey === key) { self.postMessage({ type: 'ready' }); return }
      gen = null
      const files = new Map<string, { loaded: number; total: number }>()
      gen = (await (pipeline as unknown as (...a: unknown[]) => Promise<unknown>)('text-generation', m.model, {
        device: m.device,
        dtype: m.dtype,
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === 'progress' && p.file) {
            files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
            let l = 0, t = 0
            files.forEach(f => { l += f.loaded; t += f.total })
            self.postMessage({ type: 'progress', loaded: l, total: t })
          }
        },
      })) as TextGenerationPipeline
      loadedKey = key
      self.postMessage({ type: 'ready' })
    } else if (m.type === 'generate') {
      if (!gen) throw new Error('model not loaded')
      stopper.reset()
      let acc = ''
      const streamer = new TextStreamer(gen.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (t: string) => { acc += t; self.postMessage({ type: 'token', id: m.id, text: t }) },
      })
      await gen(m.messages as never, {
        max_new_tokens: m.maxNewTokens,
        do_sample: false,
        repetition_penalty: 1.1,
        streamer,
        stopping_criteria: stopper,
      } as never)
      self.postMessage({ type: 'done', id: m.id, text: acc, stopped: stopper.interrupted })
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: (m as { id?: number }).id, message: String((err as Error)?.message ?? err) })
  }
}
