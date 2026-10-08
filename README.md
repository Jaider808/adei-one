# ADEI-ONE

**A 100% local toolbox: drop a file or some text and ADEI-ONE instantly shows you everything you can do with it — then does it, right in your browser.**

No server. No upload. No account. Every byte is processed on your own machine, and nothing ever leaves your device.

> The app UI is currently in Spanish.

## Why

Most convert / edit / clean tools ask you to upload your files to someone else's server. Your documents, photos and IDs then travel across the internet and sit on machines you don't control.

ADEI-ONE flips that: the whole toolbox is client-side. Open the page, work, close it. Your files never move.

## What it does

Drop a file and ADEI-ONE detects its real type (magic bytes, not just the extension) and shows only the actions that actually apply — so you never have to guess which tool fits.

Available today:

| Category | Tools |
| --- | --- |
| Essentials | Convert file · Encrypt file · Remove metadata |
| PDF | Split · Merge · Delete pages · Reorder pages · Compress · Extract text · Protect · Sign |
| Image | Compress · Crop · Resize · Text from image (OCR) |

Planned: video & audio, data converters (CSV/Excel/XML/JSON), and local text AI.

## Privacy model

- Everything runs in the browser (WebGPU/WASM). There is no backend.
- No uploads, no telemetry, no account.
- Usage history is stored **locally and throwaway** (Cache Storage, with a `localStorage` fallback). Clear your browser cache and it is gone.
- Secrets (passwords, tokens) are never persisted.

## Tech

React 19 · Vite · TypeScript · Tailwind CSS v4 · shadcn/ui (Radix) · Zustand · Motion · Zod · Vitest.

File engines: `pdf-lib`, `pdf.js`, `fflate`, `file-type`, `mammoth`, `docx`, `xlsx`, `tesseract.js`, `heic2any`, `libsodium` and more — all loaded lazily, per tool.

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm dev      # start the dev server
pnpm build    # type-check + production build
pnpm test     # run the test suite
pnpm lint     # oxlint
```

## License

[MIT](LICENSE). Do whatever you want with it — just keep the copyright notice.

## Attribution

See [NOTICE](NOTICE) for the third-party techniques that inspired some of the tools.
