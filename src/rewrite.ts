import { generate, type Engine, type Msg } from './llm'

export type Mode = 'simple' | 'short' | 'bullets' | 'kid' | 'polite' | 'translate'
export type TL = 'ja' | 'en'
export const MODES: Mode[] = ['simple', 'short', 'bullets', 'kid', 'polite', 'translate']

/** Japanese if a meaningful share of the letters are kana/kanji. */
export function detectLang(s: string): TL {
  const ja = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g) ?? []).length
  const en = (s.match(/[A-Za-z]/g) ?? []).length
  return ja * 3 >= en ? 'ja' : 'en'
}

const SYS: Record<TL, string> = {
  ja: 'あなたは文章をわかりやすく書き直す専門家です。元の文章の意味・事実・数字・日付・名前を変えず、新しい情報を足さないでください。書き直した文章だけを出力してください。前置きや説明は書かないでください。',
  en: 'You rewrite text so it is easy to understand. Keep the meaning, facts, numbers, dates and names exactly; never add new information. Output only the rewritten text, with no introduction or comments.',
}

const INSTR: Record<TL, Record<Exclude<Mode, 'translate'>, string>> = {
  ja: {
    simple: '次の文章を、やさしい言葉と短い文で書き直してください。難しい言葉や漢語は、ふだんの言葉に言いかえてください。',
    short: '次の文章を、大事なことだけ2〜4文で短くまとめてください。',
    bullets: '次の文章の大事なポイントを、「・」で始まる短い箇条書きにしてください。日付・時間・場所・持ち物・お金など、やるべきことは必ず入れてください。',
    kid: '次の文章を、10歳の子どもにもわかるように説明してください。やさしい言葉と短い文で、親しみやすく書いてください。',
    polite: '次の文章を、ていねいで感じのよい敬語（です・ます調）に書き直してください。内容は変えないでください。',
  },
  en: {
    simple: 'Rewrite the following text in plain, everyday English with short sentences. Replace hard or formal words with simple ones.',
    short: 'Summarize the following text in 2 to 4 sentences, keeping only what matters.',
    bullets: 'Turn the following text into short bullet points starting with "- ". Always keep dates, times, places, things to bring, money and anything the reader must do.',
    kid: "Explain the following text so a 10-year-old can understand it. Use simple words, short sentences and a friendly tone.",
    polite: 'Rewrite the following text so it is polite, warm and professional. Do not change what it says.',
  },
}

const TRANS: Record<TL, { sys: string; instr: string }> = {
  // key = target language
  en: {
    sys: 'You are a professional Japanese-to-English translator. Translate faithfully and naturally. Keep every fact, number, date and name. Output only the English translation.',
    instr: 'Translate the following Japanese text into natural English.',
  },
  ja: {
    sys: 'あなたはプロの英日翻訳者です。意味を正確に、自然な日本語に訳してください。事実・数字・日付・名前はすべて残してください。日本語訳だけを出力してください。',
    instr: '次の英語の文章を、自然な日本語に翻訳してください。',
  },
}

export function prompt(mode: Mode, src: TL, text: string): Msg[] {
  if (mode === 'translate') {
    const tgt: TL = src === 'ja' ? 'en' : 'ja'
    return [{ role: 'system', content: TRANS[tgt].sys }, { role: 'user', content: `${TRANS[tgt].instr}\n\n${text}` }]
  }
  const i = INSTR[src][mode]
  return [{ role: 'system', content: SYS[src] }, { role: 'user', content: `${i}\n\n---\n${text}\n---` }]
}

/** Split long text on paragraph/sentence boundaries. */
export function chunk(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const parts = text.split(/(?<=[。！？!?.\n])\s*/)
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    if (cur && cur.length + p.length > size) { out.push(cur); cur = '' }
    cur += (cur && !/[。！？\n]$/.test(cur) ? ' ' : '') + p
    while (cur.length > size * 1.5) { out.push(cur.slice(0, size)); cur = cur.slice(size) }
  }
  if (cur.trim()) out.push(cur)
  return out
}

export interface Prog { part: number; parts: number; tokens: number; ms: number }

export async function rewrite(
  text: string, mode: Mode, engine: Engine,
  onStream: (s: string) => void, onProg: (p: Prog) => void, stopped: () => boolean,
): Promise<string> {
  const src = detectLang(text)
  const size = engine === 'better' ? 2000 : 1200
  const pieces = chunk(text.trim(), size)
  const summaryish = mode === 'short' || mode === 'bullets'
  const outs: string[] = []
  const t0 = performance.now()
  let tokens = 0
  const run = async (msgs: Msg[], maxNew: number, prefix: string) => {
    let acc = ''
    const r = await generate(engine, msgs, maxNew, (t) => {
      acc += t; tokens++
      onStream(prefix + acc)
      onProg({ part: outs.length + 1, parts: pieces.length + (summaryish && pieces.length > 1 ? 1 : 0), tokens, ms: performance.now() - t0 })
    })
    return (r || acc).trim()
  }
  for (const p of pieces) {
    if (stopped()) break
    const maxNew = summaryish ? 300 : Math.min(1024, Math.round(p.length * (mode === 'translate' && src === 'ja' ? 1.6 : 1.3)) + 80)
    const prefix = outs.length ? outs.join('\n\n') + '\n\n' : ''
    outs.push(await run(prompt(mode, src, p), maxNew, prefix))
  }
  let result = outs.join('\n\n')
  // Several summaries → one final pass so the result stays short.
  if (summaryish && outs.length > 1 && !stopped()) result = await run(prompt(mode, src, result), 400, '')
  return clean(result)
}

/** Small models sometimes echo the separators or add a preamble. */
export function clean(s: string): string {
  return s.replace(/^-{3,}\s*$/gm, '').replace(/^(書き直し(た文章)?|翻訳|Rewritten text|Translation)\s*[:：]\s*/i, '').trim()
}
