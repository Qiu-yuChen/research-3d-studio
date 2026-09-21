import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const rootFiles = new Set([
  ".gitignore",
  ".gitattributes",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "package-lock.json",
  "index.html",
  "vite.config.js",
  "playwright.config.js",
]);
export function allowedSource(file) {
  return (
    rootFiles.has(file) ||
    /^(?:src\/[\w.-]+\.(?:js|json|css)|scripts\/[\w.-]+\.mjs|tests\/[\w.-]+\.js|tests\/fixtures\/[\w.-]+\.(?:ply|stl|obj|mtl|png|splat)|docs\/[\w.-]+\.(?:md|png)|\.github\/workflows\/[\w.-]+\.ya?ml|public\/(?:LICENSE\.txt|LOCAL_DEPLOYMENT\.txt|empty\.css|favicon\.svg|licenses\/[\w.-]+\.txt|demo\/(?:files\.json|metrics\.csv|(?:base|ours)\/[\w.-]+\.glb)))$/.test(
      file,
    )
  );
}
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  [
    "github-token",
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  ],
  ["api-token", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["cloud-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  [
    "credential-assignment",
    /(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
  ],
  [
    "private-ip",
    /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/,
  ],
  [
    "personal-absolute-path",
    /(?:\/(?:Users|home)\/[^\s/"'<>]+|[A-Za-z]:\\Users\\[^\s\\"'<>]+)/,
  ],
  ["url-credentials", /https?:\/\/[^\s/"'<>:@]+:[^\s/"'<>@]+@/i],
];
export function contentFindings(bytes) {
  const text = bytes.toString("utf8");
  const findings = rules
    .filter(([, rule]) => rule.test(text))
    .map(([name]) => name);
  // Text and EXIF chunks can retain author names, paths, or editing history.
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (["tEXt", "zTXt", "iTXt", "eXIf"].includes(type))
        findings.push("png-private-metadata");
      offset += length + 12;
    }
  }
  return [...new Set(findings)];
}
async function walk(dir, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await walk(path.join(dir, entry.name), relative + "/")));
    else files.push(relative);
  }
  return files;
}
async function sourceFiles() {
  // Never inherit a surrounding research repository's files or history.
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (path.resolve(top) === path.resolve(root)) {
      return execFileSync("git", ["ls-files", "-z"], { cwd: root })
        .toString()
        .split("\0")
        .filter(Boolean);
    }
  } catch {
    /* An extracted source archive has no Git metadata. */
  }
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      [
        ".git",
        "node_modules",
        "dist",
        "test-results",
        "playwright-report",
        ".DS_Store",
      ].includes(entry.name)
    )
      continue;
    if (entry.isDirectory())
      files.push(
        ...(await walk(path.join(root, entry.name), entry.name + "/")),
      );
    else files.push(entry.name);
  }
  return files;
}
async function main() {
  const built = process.argv.includes("--dist");
  const base = built ? path.join(root, "dist") : root;
  const files = built ? await walk(base) : await sourceFiles();
  if (!files.length)
    throw new Error(
      "No publication files found; stage source files or build first.",
    );
  const findings = [];
  for (const file of files) {
    if (!built && !allowedSource(file))
      findings.push({ file, rule: "unexpected-publication-path" });
    if (
      built &&
      (file.endsWith(".map") ||
        file.split("/").some((part) => part.startsWith(".")))
    )
      findings.push({ file, rule: "private-build-file" });
    const full = path.join(base, file);
    if ((await fs.lstat(full)).isSymbolicLink()) {
      findings.push({ file, rule: "symlink" });
      continue;
    }
    for (const rule of contentFindings(await fs.readFile(full)))
      findings.push({ file, rule });
  }
  console.log(
    JSON.stringify(
      { scope: built ? "build" : "source", files: files.length, findings },
      null,
      2,
    ),
  );
  if (findings.length) process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Publication check failed. Verify the file list, build, and file permissions.",
    );
    process.exitCode = 1;
  });
}
