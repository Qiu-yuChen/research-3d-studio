import { localizedError as i18nError } from "./i18n.js";
export const MODEL_EXTENSIONS = new Set([
  "glb",
  "gltf",
  "obj",
  "ply",
  "stl",
  "splat",
  "ksplat",
]);
export const MODES = ["color", "relight", "clay", "normal", "depth", "mask"];
export const DEFAULTS = Object.freeze({
  mode: "color",
  background: "checker",
  projection: "perspective",
  sync: true,
  normalize: true,
  azimuth: 30,
  elevation: 20,
  distance: 3.2,
  fov: 40,
  orthoSpan: 2.2,
  light: "studio",
  intensity: 1,
  exposure: 1,
  depthNear: 0.1,
  depthFar: 8,
  size: 1024,
  columns: 2,
  labels: true,
  caption: "",
  views: "0,45,90,135,180,225,270,315",
  multiView: false,
  passes: ["color", "normal"],
  padding: 24,
});
export const finite = (v) => typeof v === "number" && Number.isFinite(v);
export const delta = (a, b) => (finite(a) && finite(b) ? a - b : null);
export function normalizePath(input) {
  const parts = [];
  for (const p of String(input).replaceAll("\\", "/").split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!parts.length) throw i18nError("outsideWorkspace");
      parts.pop();
    } else parts.push(p);
  }
  return parts.join("/");
}
export const extension = (path) => path.split(".").pop().toLowerCase();
export const isModel = (path) =>
  MODEL_EXTENSIONS.has(extension(path)) || /\.mesh\.zip$/i.test(path);
export function describe(path, file) {
  const clean = normalizePath(path),
    parts = clean.split("/"),
    name = parts.pop(),
    stem = name.replace(/\.(mesh\.zip|[^.]+)$/i, "");
  return {
    id: clean,
    path: clean,
    name,
    stem,
    format: extension(clean),
    category: parts.join("/") || "Uncategorized",
    method: parts.at(-1) || "model",
    sample: stem,
    prompt: "",
    size: file.size,
    modified: file.lastModified || 0,
    metrics: {},
    rotation: [0, 0, 0],
    scale: 1,
    surface_path: "",
    up: "Y",
  };
}
export function parseCSV(text) {
  const rows = [];
  let row = [],
    s = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        s += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(s);
      s = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(s);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      s = "";
    } else s += c;
  }
  if (quoted) throw i18nError("csvQuote");
  row.push(s);
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map((x) => x.replace(/^\uFEFF/, "").trim());
  if (new Set(headers).size !== headers.length) throw i18nError("csvDuplicate");
  return rows.map((r, i) => {
    if (r.length !== headers.length)
      throw i18nError("csvColumns", { line: i + 2 });
    return Object.fromEntries(headers.map((h, j) => [h, r[j]]));
  });
}
export function parseMetadata(text, format) {
  const raw = format === "csv" ? parseCSV(text) : JSON.parse(text);
  const rows = Array.isArray(raw) ? raw : raw.assets;
  if (!Array.isArray(rows)) throw i18nError("metadataArray");
  const seen = new Set();
  return rows.map((r) => {
    if (!r.path) throw i18nError("metadataPath");
    const path = normalizePath(r.path);
    if (seen.has(path)) throw i18nError("duplicateMetricPath", { path });
    seen.add(path);
    const out = { path, metrics: {} };
    for (const k of ["sample", "method", "category", "prompt", "surface_path"])
      if (r[k] != null) out[k] = String(r[k]);
    const reserved = new Set([
      "path",
      "sample",
      "method",
      "category",
      "prompt",
      "surface_path",
      "metrics",
    ]);
    for (const [k, v] of Object.entries({
      ...Object.fromEntries(
        Object.entries(r).filter(([k]) => !reserved.has(k)),
      ),
      ...(r.metrics || {}),
    })) {
      if (v === null || v === "" || v === "NA" || v === "N/A") {
        out.metrics[k] = null;
        continue;
      }
      if (
        (typeof v !== "number" && typeof v !== "string") ||
        !Number.isFinite(Number(v))
      )
        throw i18nError("nonFiniteMetric", { metric: k, path });
      out.metrics[k] = Number(v);
    }
    return out;
  });
}
export function deltaIndex(records, key, ours, base) {
  const groups = new Map();
  for (const r of records) {
    const group = groups.get(r.sample) || new Map();
    const items = group.get(r.method) || [];
    items.push(r);
    group.set(r.method, items);
    groups.set(r.sample, group);
  }
  const out = new Map();
  for (const [sample, g] of groups) {
    const a = g.get(ours) || [],
      b = g.get(base) || [];
    out.set(
      sample,
      a.length === 1 && b.length === 1
        ? delta(a[0].metrics[key], b[0].metrics[key])
        : null,
    );
  }
  return out;
}
export function sortRecords(
  records,
  {
    sort = "name",
    descending = false,
    query = "",
    category = "",
    folder = "",
    metric = "",
    deltaMap = null,
    sign = "all",
  } = {},
) {
  const q = query.trim().toLowerCase();
  const value = (r) =>
    sort === "delta"
      ? deltaMap?.get(r.sample)
      : sort === "metric"
        ? r.metrics[metric]
        : sort === "modified"
          ? r.modified
          : sort === "size"
            ? r.size
            : sort === "category"
              ? r.category
              : sort === "format"
                ? r.format
                : r.name;
  return records
    .filter(
      (r) =>
        (!q ||
          [r.path, r.category, r.prompt, r.method, r.sample]
            .join(" ")
            .toLowerCase()
            .includes(q)) &&
        (!category || r.category === category) &&
        (!folder || r.path.startsWith(folder + "/")) &&
        (sort !== "delta" ||
          sign === "all" ||
          (finite(value(r)) &&
            (sign === "positive" ? value(r) > 0 : value(r) < 0))),
    )
    .sort((a, b) => {
      const av = value(a),
        bv = value(b),
        valid = (v) => typeof v === "string" || finite(v);
      if (!valid(av) && !valid(bv)) return a.path.localeCompare(b.path);
      if (!valid(av)) return 1;
      if (!valid(bv)) return -1;
      const n =
        typeof av === "string"
          ? av.localeCompare(bv, undefined, { numeric: true })
          : av - bv;
      return (descending ? -n : n) || a.path.localeCompare(b.path);
    });
}
export function parseAngles(text) {
  const vals = String(text)
    .split(",")
    .map((s) => s.trim());
  if (
    !vals.length ||
    vals.length > 24 ||
    vals.some((s) => s === "" || !Number.isFinite(Number(s)))
  )
    throw i18nError("invalidAngles");
  return vals.map(Number);
}
export function cleanSettings(input = {}) {
  const s = { ...DEFAULTS, ...input };
  const ranges = {
    azimuth: [-3600, 3600],
    elevation: [-89, 89],
    distance: [0.15, 100],
    fov: [10, 100],
    orthoSpan: [0.05, 100],
    intensity: [0, 5],
    exposure: [0.1, 3],
    depthNear: [0, 1000],
    depthFar: [0.01, 10000],
    size: [128, 4096],
    columns: [1, 4],
    padding: [0, 100],
  };
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    if (!finite(s[k]) || s[k] < lo || s[k] > hi)
      throw i18nError("settingRange", { setting: k });
  }
  if (s.depthFar <= s.depthNear) throw i18nError("invalidDepth");
  if (
    !MODES.includes(s.mode) ||
    !["perspective", "orthographic"].includes(s.projection) ||
    !["studio", "soft", "rim"].includes(s.light) ||
    !["checker", "white", "dark"].includes(s.background)
  )
    throw i18nError("unsupportedSettings");
  if (!Array.isArray(s.passes) || s.passes.some((v) => !MODES.includes(v)))
    throw i18nError("unknownPass");
  parseAngles(s.views);
  s.caption = String(s.caption).slice(0, 500);
  return s;
}
export function validateProject(p) {
  if (p.schema !== "research-3d-studio/v1" || !Array.isArray(p.assets))
    throw i18nError("invalidProject");
  if (p.assets.length > 100000) throw i18nError("tooManyRecords");
  if (
    p.selected &&
    (!Array.isArray(p.selected) ||
      p.selected.some((id) => typeof id !== "string"))
  )
    throw i18nError("invalidSelection");
  if (
    p.comparison &&
    (!Array.isArray(p.comparison.ids) ||
      p.comparison.ids.some((id) => typeof id !== "string") ||
      !Number.isInteger(p.comparison.page) ||
      p.comparison.page < 0)
  )
    throw i18nError("invalidPaging");
  const ids = new Set();
  for (const r of p.assets) {
    const id = normalizePath(r.path);
    if (id !== r.path || ids.has(id)) throw i18nError("invalidPaths");
    ids.add(id);
    if (
      !Array.isArray(r.rotation) ||
      r.rotation.length !== 3 ||
      !r.rotation.every(finite) ||
      !finite(r.scale) ||
      r.scale <= 0 ||
      r.scale > 10000
    )
      throw i18nError("invalidTransform");
    if (!["X", "Y", "Z"].includes(r.up)) throw i18nError("invalidUpAxis");
  }
  for (const c of Object.values(p.cameras || {})) {
    if (
      !["position", "target", "up"].every(
        (k) => Array.isArray(c[k]) && c[k].length === 3 && c[k].every(finite),
      ) ||
      !finite(c.zoom) ||
      c.zoom <= 0 ||
      c.zoom > 10000
    )
      throw i18nError("invalidCameraParams");
  }
  return { ...p, settings: cleanSettings(p.settings) };
}
export const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const formatBytes = (n) =>
  n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : (n / 1024).toFixed(0) + " KB";
export const safeName = (s) =>
  String(s)
    .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
    .slice(0, 160);
export async function sha256(file) {
  const b = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
