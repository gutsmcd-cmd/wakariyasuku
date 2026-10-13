# わかりやすく / Make It Clear

難しい文章を、やさしく言いかえる。Rewrite hard text in plain words.

Paste text, share text into the app, or take/pick a photo of a flyer, letter or notice (Japanese + English text reading on the device). A small AI running **in your browser** rewrites it:

- やさしく / Simpler
- 短くまとめる / Shorter summary
- 箇条書き / Bullet points
- 10歳にもわかるように / Explain like I'm 10
- ていねいに / Polite version
- 日本語⇄英語 / Translate Japanese ⇄ English (direction picked automatically)

How it works

- AI: Qwen2.5-0.5B-Instruct (about 0.5 GB) by default, Qwen2.5-1.5B-Instruct (about 1.2 GB) on devices with WebGPU, via [transformers.js](https://github.com/huggingface/transformers.js). Downloaded once, then cached (shared with まとめ屋 on the same site), so it works offline afterwards.
- Text in photos: [Tesseract.js](https://github.com/naptha/tesseract.js) with Japanese + English data (about 8 MB, once).
- Progress, speed (tokens/sec) and a Stop button. Copy, share, and a history kept only on your device (IndexedDB).
- It's a small AI: it can make mistakes. Check the original for anything important.
- Free. No ads. No login. No API keys. Your text and photos never leave your device.

Part of the [free app family](https://gutsmcd-cmd.github.io/free-apps/). Tests without downloading the model: add `?mock` to the URL.

MIT licence.
