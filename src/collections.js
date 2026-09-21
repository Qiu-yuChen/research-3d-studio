import { t, localizedError as i18nError } from "./i18n.js";
import { normalizePath, safeName } from "./core.js";
import { indexFiles } from "./workspace.js";

export const sourceInfo = ({ id, label, prefix, depth }) => ({
  id,
  label,
  prefix,
  depth,
});

export function newSource(files, label, sources = [], options = {}) {
  const saved = options.descriptor;
  let number = 1;
  while (sources.some((s) => s.id === `workspace-${number}`)) number++;
  const id = saved?.id || `workspace-${number}`;
  const occupied = [...combineSources(sources).keys()];
  const base = safeName(label) || "workspace";
  let prefix = sources.length ? base : "",
    suffix = 2;
  while (
    prefix &&
    (sources.some((s) => s.prefix === prefix) ||
      occupied.some((p) => p === prefix || p.startsWith(prefix + "/")))
  )
    prefix = `${base}_${suffix++}`;
  let displayLabel = label,
    labelSuffix = 2;
  while (sources.some((s) => s.label === displayLabel))
    displayLabel = `${label} (${labelSuffix++})`;
  return {
    id,
    label: saved?.label || displayLabel,
    prefix: saved?.prefix ?? prefix,
    depth: saved?.depth ?? 1,
    files,
    handle: options.handle || null,
  };
}

export function combineSources(sources) {
  const files = new Map();
  for (const source of sources)
    for (const [local, file] of source.files) {
      const path = normalizePath(
        (source.prefix ? source.prefix + "/" : "") + local,
      );
      if (
        sources.some(
          (other) =>
            other.id !== source.id &&
            other.prefix &&
            (path === other.prefix || path.startsWith(other.prefix + "/")),
        )
      )
        throw i18nError("sourceOverlap", { path });
      if (files.has(path)) throw i18nError("sourceConflict", { path });
      files.set(path, file);
    }
  return files;
}

export function sourceForPath(path, sources) {
  return [...sources]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((s) => !s.prefix || path.startsWith(s.prefix + "/"));
}

export function groupFor(record, source) {
  const local = record.localPath || record.path;
  const parts = local.split("/").slice(0, -1);
  const folder = parts.slice(0, source?.depth ?? 1).join("/");
  return { id: `${source?.id || "workspace-1"}:${folder}`, folder };
}

export function indexSources(sources, previous = []) {
  const old = new Set(previous.map((r) => r.path));
  return indexFiles(combineSources(sources), previous).map((r) => {
    const s = sourceForPath(r.path, sources);
    r.workspaceId = s.id;
    r.workspaceLabel = s.label;
    r.localPath = s.prefix ? r.path.slice(s.prefix.length + 1) : r.path;
    const group = groupFor(r, s);
    if (!old.has(r.path)) r.method = group.folder.split("/").at(-1) || s.label;
    return r;
  });
}

export function buildGroups(records, sources) {
  const groups = new Map();
  for (const r of records) {
    const s =
      sources.find((s) => s.id === r.workspaceId) ||
      sourceForPath(r.path, sources);
    const group = groupFor(r, s);
    if (!groups.has(group.id))
      groups.set(group.id, {
        ...group,
        workspaceId: s?.id,
        workspaceLabel: s?.label,
        label:
          sources.length > 1 && group.folder
            ? `${s.label} / ${group.folder}`
            : group.folder || s?.label || t("workspace"),
        records: [],
      });
    groups.get(group.id).records.push(r);
  }
  return [...groups.values()].sort(
    (a, b) =>
      sources.findIndex((s) => s.id === a.workspaceId) -
        sources.findIndex((s) => s.id === b.workspaceId) ||
      a.folder.localeCompare(b.folder, undefined, { numeric: true }),
  );
}

export function matchGroups(groups, rule = "name") {
  const buckets = new Map();
  for (const group of groups)
    for (const record of group.records) {
      const key =
        rule === "stem"
          ? record.stem
          : rule === "relative"
            ? (record.localPath || record.path).slice(
                group.folder ? group.folder.length + 1 : 0,
              )
            : record.name;
      if (!buckets.has(key)) buckets.set(key, new Map());
      const members = buckets.get(key);
      if (!members.has(group.id)) members.set(group.id, []);
      members.get(group.id).push(record);
    }
  const rows = [],
    unmatched = new Map(groups.map((g) => [g.id, []])),
    conflicts = new Set();
  for (const [key, members] of buckets) {
    const ambiguous = [...members.values()].some((rs) => rs.length > 1);
    if (!ambiguous && members.size >= 2)
      rows.push({
        key,
        cells: new Map([...members].map(([id, rs]) => [id, rs[0]])),
        records: groups.flatMap((g) => members.get(g.id) || []),
      });
    else
      for (const [id, rs] of members) {
        unmatched.get(id).push(...rs);
        if (ambiguous) for (const r of rs) conflicts.add(r.id);
      }
  }
  return { rows, unmatched, conflicts };
}

export function validateCollection(collection) {
  if (!collection) return null;
  if (!Array.isArray(collection.sources) || collection.sources.length > 1000)
    throw i18nError("invalidSources");
  const ids = new Set(),
    prefixes = new Set();
  for (const s of collection.sources) {
    if (
      typeof s.id !== "string" ||
      !s.id ||
      ids.has(s.id) ||
      typeof s.label !== "string" ||
      typeof s.prefix !== "string" ||
      normalizePath(s.prefix) !== s.prefix ||
      prefixes.has(s.prefix) ||
      !Number.isInteger(s.depth) ||
      s.depth < 0 ||
      s.depth > 3
    )
      throw i18nError("invalidSourceIds");
    ids.add(s.id);
    prefixes.add(s.prefix);
  }
  if (
    !["matched", "folders", "grid"].includes(collection.layout) ||
    !["name", "stem", "relative"].includes(collection.rule) ||
    !Array.isArray(collection.disabled) ||
    collection.disabled.some((id) => typeof id !== "string")
  )
    throw i18nError("invalidGroups");
  return collection;
}
