# Contributing

Use Node.js 22.12 or newer, run `npm ci`, then `npm run dev`.

Before submitting a change, run `npm run check:publication`, `npm audit --audit-level=moderate`, `npm test`, `npm run test:e2e`, `npm run build`, and `npm run check:publication -- --dist`. Install Chromium with `npx playwright install chromium` before the browser tests. If a feature changes a rendering convention, update the export manifest and document the change. Add a small self-authored fixture or an asset with an explicit redistribution license for loader fixes.

Keep `README.md` in English and maintain the corresponding `README.zh-CN.md`. Never commit credentials, machine-specific paths, private network addresses, or research datasets. The publication check deliberately limits source paths; update its allowlist only for files reviewed for public distribution. Use a GitHub no-reply commit email if you do not want a personal address in public history.

Keep local file data in the browser. New network services should be explicit optional integrations. Missing scores must stay missing; duplicated sample/method matches must never silently choose a result. Keep original-color rendering distinct from relighting and geometry-only passes.

Please include the file format, browser version, reproduction steps, and a minimal distributable example when reporting an issue. Do not attach private datasets or credentials.
