# Initial publication review

Reviewed on **2026-09-21** for **v0.3.1**. This is a scoped source and publication review, not a security certification or exhaustive penetration test.

## Scope

Application source, configuration, lockfile, tests, synthetic fixtures, demo models, documentation, screenshots, third-party notices, and the production build. Private research data, deployment credentials, local logs, generated test reports, and surrounding workspace history are outside the public repository.

## Findings and changes

- No hardcoded credentials, private network addresses, personal absolute paths, or authenticated service URLs were found in the publication candidate. Loopback development/test URLs and public documentation/demo links are intentional. Renderer defaults, format identifiers, and dependency versions are not deployment secrets.
- The application needs no backend address, account, API key, or environment file. Source review found only same-site demo fetches and local model loading, with no application telemetry or upload API.
- Demo GLBs contain procedural geometry, the generic Three.js exporter identifier, and no external resource URIs. PNG screenshots and fixtures contain no text or EXIF metadata; screenshots were visually reviewed and show synthetic assets.
- Upgraded **fflate 0.8.2 → 0.8.3** to fix the malformed ZIP64 parsing issue described in [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98). `npm audit` reported **0 known vulnerabilities** after the upgrade, including development dependencies, at review time.
- Added a publication allowlist and checks for common credentials, private IPs, personal paths, symlinks, and PNG text/EXIF metadata. Ignore rules exclude local credentials, editor settings, imported datasets, archives, and build/test outputs.
- Git history starts with this standalone application. Publication uses a GitHub no-reply author address rather than a personal email address. The CI token has read-only repository permissions and checkout does not persist its credentials.
- Documented browser-local persistence and the fact that exported projects/manifests are **not anonymized**. Portable projects intentionally include workspace files; users must inspect them before sharing.

## Verification

- `npm run check:publication`: source candidate passed.
- `npm test`: **15 tests passed**, including publication-rule positive and negative cases.
- Browser workflows: **13 tests passed** in total, covering existing rendering, project/archive, multi-workspace and language workflows plus two security regression tests.
- A model referencing a remote HTTP buffer was rejected without making the request.
- HTML-like imported labels remained literal text in the gallery and exported SVG; no injected image, event handler, or script was created.
- `npm run build` and `npm run check:publication -- --dist`: passed. The production build has no source maps.

## Limits

Pattern checks cannot identify every secret, proprietary asset, or malicious payload. Binary data and screenshots still require human review. The dependency audit is a snapshot of the registry's advisory data. This review does not cover hosting-provider settings, browser extensions, future changes, or arbitrary user models. Large or malicious models/archives can still exhaust browser resources. See [SECURITY.md](../SECURITY.md) for data handling and private reporting.
