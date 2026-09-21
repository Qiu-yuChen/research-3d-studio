# Security and privacy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Qiu-yuChen/research-3d-studio/security/advisories/new). Include a minimal synthetic reproduction and the affected version. Do not attach private models, credentials, or personal files to a public issue. Security fixes target the latest release.

## Data handling

- Model parsing and rendering run in the browser. The application has no account system, upload API, analytics, or remote inference service. Demo files are loaded from the same static site.
- Folder connections request read permission. Directory handles are stored in IndexedDB; preferences, project metadata, and relative file names are stored in browser-local storage. Clearing this site's browser data removes saved settings and handles.
- External HTTP(S) resources referenced by models are rejected. Include texture and buffer sidecars in the selected workspace. Embedded data and locally generated blob URLs are supported.
- **Exports are not anonymized.** Project JSON and figure manifests include relative paths, workspace labels, prompts, metrics, file hashes, and rendering settings; figure manifests also include the browser user agent. A portable project ZIP includes workspace files, including sidecars and other imported files. Select a dedicated project directory and inspect exports before sharing them.
- Imported files and browser/GPU resources are not comprehensively sandboxed by this application. Extremely large or malicious models and archives can exhaust memory or stall a tab. Use trusted assets and keep your browser updated.

## Deployment

Build with `npm run build` and publish **only `dist/`**. Do not serve your home directory, dataset directory, source checkout, `.git`, or configuration files. For local use, bind the static server to loopback as shown in the README. Remote hosting should use HTTPS.

The static frontend requires no API keys, server address, login, or `.env` file. Values compiled into frontend code are public: never add secrets to Vite environment variables or JavaScript. A hosting provider may add its own access logs or analytics; inspect its configuration separately. The offline static release does not require such services.

## Publication checks

`npm run check:publication` scans the Git index's file list (or an explicit source allowlist before Git initialization), reads those files from the working tree, rejects unexpected publication paths, and checks for common credential patterns, private IP addresses, personal absolute paths, and symlinks. `npm run check:publication -- --dist` scans the build too. It reports file names and rule names, never matching secret values.

The scanner is a small preventive check, not a complete secret detector or a penetration test. Review screenshots, binary metadata, new dependencies, exported projects, and commit author identity before publishing. Git ignore rules do not protect files that were already committed. See [the initial publication review](docs/SECURITY_REVIEW.md) for the scope and limitations of this release's review.
