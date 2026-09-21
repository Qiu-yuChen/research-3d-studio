import { localizedError as i18nError } from "./i18n.js";
import { normalizePath, describe, isModel } from "./core.js";
const IGNORED = new Set(["node_modules", ".git", ".hg", ".svn", "__MACOSX"]);
async function database() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("research-3d-studio", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("workspace");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function rememberHandle(handle) {
  const db = await database();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("workspace", "readwrite");
    tx.objectStore("workspace").put(handle, "last");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
export async function recallHandle() {
  const db = await database();
  const v = await new Promise((resolve, reject) => {
    const r = db.transaction("workspace").objectStore("workspace").get("last");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return v;
}
export async function scanDirectory(handle, onProgress = () => {}) {
  const files = new Map();
  async function walk(dir, prefix = "") {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith(".") || IGNORED.has(name)) continue;
      const path = normalizePath(prefix + name);
      if (h.kind === "directory") await walk(h, path + "/");
      else {
        files.set(path, await h.getFile());
        if (files.size % 100 === 0) onProgress(files.size);
      }
    }
  }
  await walk(handle);
  return files;
}
export function fileListMap(list) {
  const files = [...list],
    out = new Map();
  for (const f of files) {
    let path = f.webkitRelativePath || f.name;
    if (f.webkitRelativePath) path = path.split("/").slice(1).join("/");
    path = normalizePath(path);
    if (out.has(path)) throw i18nError("pathConflict", { path });
    out.set(path, f);
  }
  return out;
}
export async function droppedFiles(items, files) {
  const entries = [...items].map((x) => x.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return fileListMap(files);
  const out = new Map();
  async function walk(e, prefix = "") {
    if (e.name.startsWith(".") || IGNORED.has(e.name)) return;
    if (e.isFile) {
      const file = await new Promise((a, b) => e.file(a, b));
      out.set(normalizePath(prefix + e.name), file);
    } else {
      const reader = e.createReader();
      let batch;
      do {
        batch = await new Promise((a, b) => reader.readEntries(a, b));
        for (const sub of batch) await walk(sub, prefix + e.name + "/");
      } while (batch.length);
    }
  }
  // One dropped directory is the workspace root, just like directory picking.
  if (entries.length === 1 && entries[0].isDirectory) {
    const root = entries[0],
      reader = root.createReader();
    let batch;
    do {
      batch = await new Promise((a, b) => reader.readEntries(a, b));
      for (const e of batch) await walk(e);
    } while (batch.length);
  } else for (const e of entries) await walk(e);
  return out;
}
export function indexFiles(files, previous = []) {
  const old = new Map(previous.map((r) => [r.path, r]));
  return [...files]
    .filter(([p]) => isModel(p))
    .map(([p, f]) => ({
      ...describe(p, f),
      ...(old.has(p)
        ? Object.fromEntries(
            [
              "category",
              "method",
              "sample",
              "prompt",
              "metrics",
              "rotation",
              "scale",
              "surface_path",
              "up",
            ].map((k) => [k, old.get(p)[k]]),
          )
        : {}),
      size: f.size,
      modified: f.lastModified || 0,
    }));
}
export function fileSignature(files) {
  return [...files]
    .map(([p, f]) => `${p}:${f.size}:${f.lastModified}`)
    .sort()
    .join("|");
}
