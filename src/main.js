import {
  t,
  message as msg,
  localizedError as i18nError,
  getLanguage,
  setLanguage,
  translatePage,
  messageText,
} from "./i18n.js";
import "./style.css";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import {
  DEFAULTS,
  MODES,
  normalizePath,
  extension,
  parseMetadata,
  sortRecords,
  deltaIndex,
  cleanSettings,
  validateProject,
  escapeHTML as esc,
  formatBytes,
  sha256,
  safeName,
  finite,
} from "./core.js";
import {
  scanDirectory,
  fileListMap,
  droppedFiles,
  rememberHandle,
  recallHandle,
  fileSignature,
} from "./workspace.js";
import { Viewport } from "./viewport.js";
import {
  sourceInfo,
  newSource,
  combineSources,
  sourceForPath,
  indexSources,
  buildGroups,
  matchGroups,
  validateCollection,
} from "./collections.js";
import { download, jsonBlob, projectRecord, exportBatch } from "./export.js";
const $ = (id) => document.getElementById(id);
let files = new Map(),
  records = [],
  selected = new Set(),
  settings = { ...DEFAULTS, passes: [...DEFAULTS.passes] },
  sources = [],
  collectionLayout = "matched",
  matchRule = "name",
  disabledGroups = new Set(),
  matchedRows = [],
  comparisonIds = [],
  comparisonPage = 0,
  pendingDirectoryTarget = null,
  workspaceName = "Workspace",
  folder = "",
  descending = false,
  limit = 48,
  metadata = [],
  pendingProject = null,
  viewports = [],
  active = null,
  workspaceEpoch = 0,
  refreshing = false,
  cancelExport = false,
  busy = false,
  cameraState = null,
  restoreNotice = "";
const thumbs = new Map(),
  errors = new Map();
let lastStatus = msg("ready"),
  statusIsError = false;
function status(text, error = false) {
  lastStatus = text;
  statusIsError = error;
  renderStatus();
}
function renderStatus() {
  $("status").textContent = messageText(lastStatus);
  $("status").classList.toggle("error", statusIsError);
}
function workspaceTitle() {
  return sources.length === 1
    ? sources[0].label
    : sources.length
      ? t("workspaceCount", { count: sources.length })
      : t("noWorkspace");
}
function refreshLanguage() {
  translatePage();
  setWorkspaceUI();
  renderGallery();
  updateComparePaging();
  for (const v of viewports) updateViewNote(v);
  $("sortDirection").textContent = t(descending ? "descending" : "ascending");
  if (!active) $("activeName").textContent = t("previewFirst");
  renderStatus();
}
const guard =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e.name !== "AbortError") status(e, true);
    }
  };
function persist() {
  try {
    localStorage.setItem(
      "r3d-session",
      JSON.stringify({
        schema: "research-3d-studio/v1",
        settings,
        workspace: workspaceName,
        cameras: Object.fromEntries(
          viewports.map((v) => [v.record.path, v.view.cameraRecord()]),
        ),
        assets: records.map((r) => ({ ...r })),
        selected: [...selected],
        collection: collectionRecord(),
        comparison: { ids: comparisonIds, page: comparisonPage },
      }),
    );
  } catch {}
}
function toggleBusy(value) {
  busy = value;
  document.body.classList.toggle("busy", value);
  for (const id of [
    "exportBatch",
    "exportCurrent",
    "openWorkspace",
    "appendWorkspace",
    "addFiles",
    "refreshWorkspace",
    "demoButton",
    "saveProject",
    "packProject",
    "loadProject",
  ])
    $(id).disabled = value;
  for (const v of viewports) v.view.controls.enabled = !value;
}
function setWorkspaceUI() {
  $("workspaceName").textContent = workspaceTitle();
  $("assetCount").textContent = t("modelCount", { count: records.length });
  $("fileTotal").textContent = t("fileCount", { count: files.size });
  const connected = sources.filter((s) => s.handle).length;
  $("workspaceHint").textContent = sources.length
    ? t("workspaceSummary", {
        count: sources.length,
        connected,
        snapshots: sources.length - connected,
      })
    : t("workspaceHint");
  $("autoRefresh").disabled = !connected;
  $("refreshWorkspace").title = t("refreshHint");
  $("workspaceSources").innerHTML = sources
    .map(
      (s) =>
        `<div class="workspace-source" data-source="${esc(s.id)}"><div><strong title="${esc(s.label)}">${esc(s.label)}</strong><button data-remove-source="${esc(s.id)}" title="${esc(t("removeWorkspaceHint"))}" aria-label="${esc(t("removeWorkspace", { name: s.label }))}">×</button></div><span class="hint">${s.handle ? t("connectedFolder") : t("fileSnapshot")} · ${t("modelCount", { count: records.filter((r) => r.workspaceId === s.id).length })}</span><label>${t("grouping")}<select data-source-depth="${esc(s.id)}" aria-label="${esc(t("groupDepth", { name: s.label }))}">${[
          [0, t("wholeWorkspace")],
          [1, t("depth1")],
          [2, t("depth2")],
          [3, t("depth3")],
        ]
          .map(
            ([n, label]) =>
              `<option value="${n}" ${s.depth === n ? "selected" : ""}>${label}</option>`,
          )
          .join(
            "",
          )}</select></label><button class="quiet" data-update-source="${esc(s.id)}">${t("updateReconnect")}</button></div>`,
    )
    .join("");
  $("collectionLayout").value = collectionLayout;
  $("matchRule").value = matchRule;
  const categories = [...new Set(records.map((r) => r.category))].sort();
  const oldCategory = $("category").value;
  $("category").replaceChildren(
    new Option(t("allCategories"), ""),
    ...categories.map((c) => new Option(c, c)),
  );
  if (categories.includes(oldCategory)) $("category").value = oldCategory;
  const paths = new Set();
  for (const r of records) {
    const bits = r.path.split("/");
    bits.pop();
    for (let i = 1; i <= bits.length; i++)
      paths.add(bits.slice(0, i).join("/"));
  }
  if (folder && !paths.has(folder)) folder = "";
  $("folderTree").innerHTML =
    `<button class="folder ${folder === "" ? "selected" : ""}" data-folder="">${t("allModels")} <span class="num">${records.length}</span></button>` +
    [...paths]
      .sort()
      .map(
        (p) =>
          `<button class="folder ${folder === p ? "selected" : ""}" data-folder="${esc(p)}" style="padding-left:${12 + (p.split("/").length - 1) * 12}px" title="${esc(p)}">▱ ${esc(p.split("/").at(-1))} <span class="num">${records.filter((r) => r.path.startsWith(p + "/")).length}</span></button>`,
      )
      .join("");
  updateMetricOptions();
  updateSurface();
}
function updateMetricOptions() {
  const metrics = [
      ...new Set(records.flatMap((r) => Object.keys(r.metrics))),
    ].sort(),
    methods = [...new Set(records.map((r) => r.method))].sort();
  const preserve = (id, values, def) => {
    const old = $(id).value;
    $(id).replaceChildren(...values.map((x) => new Option(x, x)));
    $(id).value = values.includes(old)
      ? old
      : values.includes(def)
        ? def
        : values[0] || "";
  };
  preserve("metric", metrics, "clip");
  preserve(
    "ours",
    methods,
    methods.find((x) => /^ours$/i.test(x)),
  );
  preserve(
    "base",
    methods,
    methods.find((x) => /^base$/i.test(x)),
  );
}
function getFiltered() {
  const sort = $("sort").value;
  return sortRecords(records, {
    sort,
    descending,
    query: $("search").value,
    category: $("category").value,
    folder,
    metric: $("metric").value,
    deltaMap: deltaIndex(
      records,
      $("metric").value,
      $("ours").value,
      $("base").value,
    ),
    sign: $("sign").value,
  });
}
function renderGallery() {
  const sorted = getFiltered(),
    sort = $("sort").value,
    metric = $("metric").value,
    deltas = deltaIndex(records, metric, $("ours").value, $("base").value);
  $("metricFilters").hidden = !["metric", "delta"].includes(sort);
  document
    .querySelectorAll(".delta-field")
    .forEach((e) => (e.hidden = sort !== "delta"));
  $("metricNote").textContent =
    sort === "delta" ? t("deltaNote") : t("metricNote");
  $("resultCount").textContent = t("resultCount", {
    count: sorted.length,
    categories: new Set(sorted.map((r) => r.category)).size,
  });
  $("empty").hidden = records.length > 0;
  const groups = buildGroups(records, sources);
  $("groupChoices").innerHTML = groups
    .map(
      (g) =>
        `<label class="group-chip"><input type="checkbox" data-group="${esc(g.id)}" ${disabledGroups.has(g.id) ? "" : "checked"}>${esc(g.label)} <span>${g.records.length}</span></label>`,
    )
    .join("");
  const participating = groups.filter((g) => !disabledGroups.has(g.id));
  const membership = new Map(
    participating.flatMap((g) => g.records.map((r) => [r.id, g.id])),
  );
  const visibleIds = new Set(sorted.map((r) => r.id));
  // Match against the complete groups first. A search must not hide a duplicate
  // and accidentally turn an ambiguous key into an apparently valid match.
  const matched = matchGroups(participating, matchRule);
  const ranks = new Map(sorted.map((r, i) => [r.id, i]));
  matchedRows = matched.rows
    .filter((row) => row.records.some((r) => visibleIds.has(r.id)))
    .sort(
      (a, b) =>
        Math.min(...a.records.map((r) => ranks.get(r.id) ?? Infinity)) -
        Math.min(...b.records.map((r) => ranks.get(r.id) ?? Infinity)),
    );
  const card = (r) => {
    const val = sort === "delta" ? deltas.get(r.sample) : r.metrics[metric];
    return `<article class="model-card ${selected.has(r.id) ? "chosen" : ""}" data-id="${esc(r.id)}"><div class="thumb-wrap"><input type="checkbox" class="select-model" data-select="${esc(r.id)}" aria-label="${esc(t("selectModel", { name: r.name }))}" ${selected.has(r.id) ? "checked" : ""}><button class="thumb" data-preview="${esc(r.id)}" aria-label="${esc(t("previewName", { name: r.name }))}">${thumbs.has(r.id) ? `<img src="${thumbs.get(r.id)}" alt="${esc(t("thumbnail", { name: r.name }))}">` : '<span class="placeholder">◇</span>'}<span class="format-badge">${esc(r.format.toUpperCase())}</span></button></div><div class="card-body"><div class="card-name" title="${esc(r.path)}">${esc(r.name)}</div><div class="card-meta"><span>${formatBytes(r.size)}</span><span>${r.modified ? new Date(r.modified).toLocaleDateString(getLanguage() === "zh" ? "zh-CN" : "en-US") : "—"}</span></div><span class="card-category" title="${esc(r.category)}">${esc(r.category)} · ${esc(r.method)}</span>${["metric", "delta"].includes(sort) ? `<div class="card-metric">${sort === "delta" ? "Δ " : ""}${esc(metric || t("noMetrics"))} ${finite(val) ? (val > 0 && sort === "delta" ? "+" : "") + val.toFixed(4) : "—"}</div>` : ""}${errors.has(r.id) ? `<div class="hint error">${esc(messageText(errors.get(r.id)))}</div>` : ""}</div></article>`;
  };
  const cardHTML = (r) =>
    card(r).replace(
      "</div></article>",
      `${matched.conflicts.has(r.id) ? `<div class="hint error">${t("nameConflict")}</div>` : ""}<div class="card-path" title="${esc(r.path)}">${esc(r.localPath || r.path)}</div></div></article>`,
    );
  const folderSection = (group, rs, title = "") =>
    `<section class="folder-section" data-folder-group="${esc(group.id)}"><header><strong>${esc(group.label)}</strong><span>${title} ${t("modelCount", { count: rs.length })}</span></header><div class="folder-grid">${rs.map(cardHTML).join("")}</div></section>`;
  let shown = [],
    hasMore = false;
  $("gallery").classList.toggle("grouped-gallery", collectionLayout !== "grid");
  if (collectionLayout === "grid") {
    shown = sorted.filter((r) => membership.has(r.id)).slice(0, limit);
    $("gallery").innerHTML = shown.map(cardHTML).join("");
    hasMore = sorted.filter((r) => membership.has(r.id)).length > limit;
  } else if (collectionLayout === "folders") {
    const chunks = participating
      .map((g) => ({
        g,
        rs: sorted.filter((r) => membership.get(r.id) === g.id),
      }))
      .filter((x) => x.rs.length);
    $("gallery").innerHTML = chunks
      .map(({ g, rs }) => {
        shown.push(...rs.slice(0, limit));
        hasMore ||= rs.length > limit;
        return folderSection(g, rs.slice(0, limit));
      })
      .join("");
  } else {
    const rowLimit = Math.max(
      1,
      Math.floor(limit / Math.max(1, participating.length)),
    );
    const rows = matchedRows.slice(0, rowLimit);
    hasMore = matchedRows.length > rowLimit;
    const table = rows.length
      ? `<div class="match-table"><div class="match-columns" style="--groups:${participating.length}">${participating.map((g) => `<strong title="${esc(g.label)}">${esc(g.label)}</strong>`).join("")}</div>${rows
          .map((row, i) => {
            shown.push(...row.records);
            return `<section class="match-row" data-match-key="${esc(row.key)}"><header><div><strong>${esc(row.key)}</strong><span>${t("methodCount", { count: row.records.length, total: participating.length })}</span></div><div><button data-compare-row="${i}" class="accent">${t("compareRow")}</button><button data-select-row="${i}" class="quiet">${t("addToExport")}</button></div></header><div class="match-cells" style="--groups:${participating.length}">${participating.map((g) => (row.cells.has(g.id) ? cardHTML(row.cells.get(g.id)) : `<div class="missing-cell">—<span>${esc(t("missingMatch", { name: g.label }))}</span></div>`)).join("")}</div></section>`;
          })
          .join("")}</div>`
      : "";
    const remainder = participating
      .map((g) => ({
        g,
        rs: matched.unmatched
          .get(g.id)
          .filter((r) => visibleIds.has(r.id))
          .sort((a, b) => ranks.get(a.id) - ranks.get(b.id)),
      }))
      .filter((x) => x.rs.length);
    const unmatchedHTML = remainder
      .map(({ g, rs }) => {
        shown.push(...rs.slice(0, limit));
        hasMore ||= rs.length > limit;
        return folderSection(
          g,
          rs.slice(0, limit),
          rows.length ? t("unmatchedPrefix") : "",
        );
      })
      .join("");
    $("gallery").innerHTML =
      table +
      (rows.length && remainder.length
        ? `<h3 class="unmatched-title">${t("unmatchedTitle")}</h3>`
        : "") +
      unmatchedHTML;
  }
  $("matchSummary").textContent = t("matchSummary", {
    groups: participating.length,
    matches: matchedRows.length,
    conflicts: matched.conflicts.size
      ? t("conflictCount", { count: matched.conflicts.size })
      : "",
  });
  if (records.length && !shown.length)
    $("gallery").innerHTML = `<p class="hint">${t("noVisibleModels")}</p>`;
  if (records.length && !sorted.length)
    $("gallery").innerHTML = `<p class="hint">${t("noMatchingModels")}</p>`;
  $("moreModels").hidden = !hasMore;
  updateSelection();
  startThumbnails(shown);
}
function updateSelection() {
  $("selectedCount").textContent = selected.size;
  $("trayCount").textContent = t("modelCount", { count: selected.size });
  $("selectionTray").hidden = selected.size === 0;
  document
    .querySelectorAll(".model-card")
    .forEach((e) => e.classList.toggle("chosen", selected.has(e.dataset.id)));
  $("compareSelected").disabled = selected.size === 0 || busy;
}
let thumbnailRunning = false,
  thumbnailPending = [];
function startThumbnails(rs) {
  thumbnailPending = rs.filter((r) => !thumbs.has(r.id) && !errors.has(r.id));
  if (!thumbnailRunning) void processThumbnails();
}
async function processThumbnails() {
  if (!thumbnailPending.length) return;
  thumbnailRunning = true;
  const epoch = workspaceEpoch;
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:240px;height:240px";
  document.body.append(host);
  let vp;
  try {
    vp = new Viewport(
      host,
      { ...DEFAULTS, mode: "relight" },
      { interactive: false },
    );
    while (thumbnailPending.length && epoch === workspaceEpoch) {
      const r = thumbnailPending.shift();
      if (!r || thumbs.has(r.id)) continue;
      try {
        await vp.load(r, files);
        if (epoch !== workspaceEpoch) break;
        vp.fit();
        const image = await vp.capture(
          vp.supported("relight") ? "relight" : "color",
          256,
        );
        const url = URL.createObjectURL(image);
        thumbs.set(r.id, url);
        for (const e of document.querySelectorAll(".model-card"))
          if (e.dataset.id === r.id) {
            const button = e.querySelector(".thumb");
            const im = document.createElement("img");
            im.src = url;
            im.alt = t("thumbnail", { name: r.name });
            button.querySelector(".placeholder")?.replaceWith(im);
          }
      } catch (e) {
        errors.set(r.id, e);
        for (const card of document.querySelectorAll(".model-card"))
          if (card.dataset.id === r.id) {
            const p = document.createElement("p");
            p.className = "hint error";
            p.textContent = e.message;
            card.querySelector(".card-body").append(p);
          }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await vp?.dispose();
    host.remove();
    thumbnailRunning = false;
    if (thumbnailPending.length) void processThumbnails();
  }
}
function collectionRecord() {
  return {
    sources: sources.map(sourceInfo),
    layout: collectionLayout,
    rule: matchRule,
    disabled: [...disabledGroups],
  };
}
async function rememberSources() {
  try {
    await rememberHandle(
      sources.map((s) => ({ ...sourceInfo(s), handle: s.handle })),
    );
    $("reconnect").hidden = !sources.some((s) => s.handle);
  } catch {
    /* Private browsing may disallow durable handles. */
  }
}
async function commitSources(
  nextSources,
  { replace = false, readMetadata = true } = {},
) {
  if (busy) throw i18nError("waitForExport");
  const nextFiles = combineSources(nextSources);
  const imported = [];
  if (readMetadata)
    for (const source of nextSources) {
      for (const path of [
        "metrics.csv",
        "metrics.json",
        "metadata.csv",
        "metadata.json",
      ]) {
        if (!source.files.has(path)) continue;
        const rows = parseMetadata(
          await source.files.get(path).text(),
          extension(path),
        );
        for (const row of rows) {
          const prefix = source.prefix ? source.prefix + "/" : "";
          imported.push({
            ...row,
            path: prefix + row.path,
            ...(row.surface_path
              ? { surface_path: prefix + normalizePath(row.surface_path) }
              : {}),
          });
        }
        break;
      }
    }
  const previous = replace ? [] : records;
  workspaceEpoch++;
  thumbnailPending = [];
  viewEpoch++;
  const oldIds = replace ? [] : comparisonIds.filter((id) => nextFiles.has(id));
  const wasLibrary = $("comparePane").hidden;
  await closeViews();
  for (const u of thumbs.values()) URL.revokeObjectURL(u);
  thumbs.clear();
  errors.clear();
  if (replace) {
    selected.clear();
    folder = "";
    metadata = [];
  }
  sources = nextSources;
  files = nextFiles;
  records = indexSources(sources, previous);
  workspaceName =
    sources.length === 1
      ? sources[0].label
      : sources.length
        ? `${sources.length} workspaces`
        : "Workspace";
  selected = new Set([...selected].filter((id) => files.has(id)));
  if (readMetadata)
    metadata = [
      ...new Map(
        [...metadata.filter((m) => files.has(m.path)), ...imported].map((m) => [
          m.path,
          m,
        ]),
      ).values(),
    ];
  mergeMetadata();
  restoreNotice = "";
  if (pendingProject) await restorePending();
  else if (oldIds.length) await openViews(oldIds);
  else {
    comparisonIds = [];
    updateComparePaging();
  }
  setWorkspaceUI();
  renderGallery();
  if (wasLibrary || replace) tab("library");
  status(
    () =>
      t("filesRead", {
        workspace: workspaceTitle(),
        models: records.length,
        files: files.size,
        notice: restoreNotice ? " · " + messageText(restoreNotice) : "",
      }),
    !!restoreNotice,
  );
  persist();
}
async function applyFiles(
  next,
  name,
  { append = false, handle = null, target = null, descriptors = null } = {},
) {
  let nextSources;
  if (descriptors?.length) {
    nextSources = descriptors.map((d) => ({
      ...d,
      files: new Map(),
      handle: null,
    }));
    for (const [path, file] of next) {
      const source = sourceForPath(path, nextSources);
      if (!source) throw i18nError("missingSource", { path });
      source.files.set(
        source.prefix ? path.slice(source.prefix.length + 1) : path,
        file,
      );
    }
  } else {
    // When reconnecting a JSON project, retain its explicit mount identities.
    const waiting = sources.filter(
      (source) => !source.files.size && source.label === name,
    );
    const existing =
      sources.find((source) => source.id === target) ||
      (waiting.length === 1 ? waiting[0] : null);
    if (existing)
      nextSources = sources.map((source) =>
        source === existing ? { ...source, files: next, handle } : source,
      );
    else {
      const remaining = append ? sources : [];
      const saved = pendingProject?.collection?.sources?.filter(
        (d) =>
          d.label === name && !remaining.some((source) => source.id === d.id),
      );
      nextSources = [
        ...remaining,
        newSource(next, name, remaining, {
          handle,
          descriptor: saved?.length === 1 ? saved[0] : null,
        }),
      ];
    }
  }
  await commitSources(nextSources, {
    replace:
      !append &&
      !target &&
      !sources.some((source) => !source.files.size && source.label === name),
  });
  await rememberSources();
}
function mergeMetadata() {
  for (const m of metadata) {
    const r = records.find((x) => x.path === m.path);
    if (r) Object.assign(r, m);
  }
}
async function openDirectory(append = false, target = null) {
  if (window.showDirectoryPicker) {
    const h = await window.showDirectoryPicker({
      mode: "read",
      id: "research-3d-workspace",
    });
    const others = append
      ? sources.filter((s) => s.id !== target && s.handle)
      : [];
    for (const source of others)
      if (await h.isSameEntry(source.handle)) {
        status(msg("alreadyConnected"));
        return applyFiles(await scanDirectory(h), source.label, {
          handle: h,
          target: source.id,
        });
      }
    status(msg("scanning"));
    const next = await scanDirectory(h, (n) =>
      status(msg("readingFiles", { count: n })),
    );
    await applyFiles(next, h.name, { handle: h, append, target });
  } else {
    pendingDirectoryTarget = target;
    $(append || target ? "appendDirectoryInput" : "directoryInput").click();
  }
}
async function rescan(quiet = false) {
  if (!sources.some((s) => s.handle)) {
    if (!quiet) status(msg("snapshotRefresh"));
    return;
  }
  if (refreshing || busy) return;
  refreshing = true;
  const epoch = workspaceEpoch,
    currentSources = sources;
  try {
    const scans = await Promise.allSettled(
      currentSources.map((s) =>
        s.handle ? scanDirectory(s.handle) : Promise.resolve(s.files),
      ),
    );
    if (epoch !== workspaceEpoch) return;
    const failures = scans.flatMap((r, i) =>
      r.status === "rejected" ? [currentSources[i].label] : [],
    );
    const next = currentSources.map((s, i) => ({
      ...s,
      files: scans[i].status === "fulfilled" ? scans[i].value : s.files,
    }));
    if (
      next.some(
        (s, i) =>
          fileSignature(s.files) !== fileSignature(currentSources[i].files),
      )
    ) {
      await commitSources(next, { readMetadata: false });
      status(msg("syncedFiles"));
    } else if (!quiet) status(msg("upToDate"));
    if (failures.length)
      status(msg("refreshFailures", { names: failures.join(", ") }), true);
  } finally {
    refreshing = false;
  }
}
async function closeViews() {
  const old = viewports;
  viewports = [];
  active = null;
  await Promise.all(old.map((v) => v.view.dispose()));
  $("viewports").replaceChildren();
  $("compareEmpty").hidden = false;
}
function tab(which) {
  $("libraryPane").hidden = which !== "library";
  $("comparePane").hidden = which !== "compare";
  for (const name of ["library", "compare"]) {
    const on = which === name;
    $(name + "Tab").classList.toggle("active", on);
    $(name + "Tab").setAttribute("aria-selected", on);
  }
}
let viewEpoch = 0;
function updateComparePaging() {
  const start = comparisonPage * 4;
  $("compareCount").textContent = comparisonIds.length;
  $("comparePaging").hidden = comparisonIds.length <= 4;
  $("comparePageLabel").textContent = t("comparePage", {
    start: start + 1,
    end: Math.min(start + 4, comparisonIds.length),
    total: comparisonIds.length,
  });
  $("comparePrevious").disabled = comparisonPage === 0;
  $("compareNext").disabled = start + 4 >= comparisonIds.length;
}
async function openViews(ids, page = 0) {
  const ticket = ++viewEpoch;
  comparisonIds = [...new Set(ids)].filter((id) => files.has(id));
  comparisonPage = Math.max(
    0,
    Math.min(page, Math.ceil(comparisonIds.length / 4) - 1),
  );
  ids = comparisonIds.slice(comparisonPage * 4, comparisonPage * 4 + 4);
  updateComparePaging();
  const saved = cameraState;
  await closeViews();
  if (ticket !== viewEpoch) return;
  tab("compare");

  $("compareEmpty").hidden = ids.length > 0;
  $("viewports").classList.toggle("single", ids.length === 1);
  for (const id of ids) {
    if (ticket !== viewEpoch) return;
    const record = records.find((r) => r.id === id);
    if (!record) continue;
    const tile = document.createElement("article");
    tile.className = "viewport-card";
    tile.dataset.id = id;
    tile.innerHTML = `<div class="viewport-title"><strong>${esc(record.name)}</strong><span>${esc(buildGroups(records, sources).find((g) => g.records.some((r) => r.id === id))?.label || record.method)}</span></div><div class="canvas-stage"></div><div class="viewport-note">${t("loadingModel")}</div>`;
    $("viewports").append(tile);
    const v = {
      record,
      tile,
      view: new Viewport(tile.querySelector(".canvas-stage"), settings, {
        onCamera: (pose) => cameraChanged(pose, id),
      }),
    };
    viewports.push(v);
    tile.querySelector(".viewport-title").onclick = () => focus(id);
    try {
      await v.view.load(record, files);
      if (ticket !== viewEpoch) return;
      if (saved) v.view.applyCamera(saved);
      else v.view.fit();
      updateViewNote(v);
    } catch (e) {
      v.error = e;
      tile.querySelector(".viewport-note").textContent = messageText(e);
      tile.querySelector(".viewport-note").classList.add("error");
    }
  }
  if (ids.length) focus(ids[0]);
  persist();
}
function cameraChanged(pose, id) {
  cameraState = pose;
  if (settings.sync)
    for (const v of viewports) if (v.record.id !== id) v.view.applyCamera(pose);
  const p = pose.position,
    t = pose.target,
    dx = p[0] - t[0],
    dy = p[1] - t[1],
    dz = p[2] - t[2],
    d = Math.hypot(dx, dy, dz);
  if (d > 0) {
    settings.distance = Math.min(100, d);
    settings.azimuth = (Math.atan2(dx, dz) * 180) / Math.PI;
    settings.elevation = (Math.asin(dy / d) * 180) / Math.PI;
    for (const k of ["azimuth", "elevation", "distance"])
      $(k).value = settings[k].toFixed(2);
  }
}
function updateViewNote(v) {
  const vp = v.view,
    note = v.tile.querySelector(".viewport-note");
  if (!vp.ready) {
    note.textContent = v.error ? messageText(v.error) : t("loadingModel");
    note.classList.toggle("error", !!v.error);
    return;
  }
  note.classList.toggle("error", vp.unsupported);
  note.textContent = vp.unsupported
    ? t("surfaceRequired")
    : `${vp.stats?.type || ""} · ${Math.round(vp.stats?.primitives || 0).toLocaleString()} ${vp.stats?.type === "Mesh" ? "triangles" : "points"} · ${t(vp.effectiveMode)}${vp.kind === "gaussian" && vp.effectiveMode !== "color" ? t("fromMesh") : ""}`;
}
function focus(id) {
  active = id;
  for (const v of viewports)
    v.tile.classList.toggle("focused", v.record.id === id);
  const r = records.find((r) => r.id === id);
  if (!r) return;
  $("activeName").textContent = r.path;
  $("up").value = r.up;
  ["rotateX", "rotateY", "rotateZ"].forEach(
    (k, i) => ($(k).value = r.rotation[i]),
  );
  $("modelScale").value = r.scale;
  for (const [id, key] of [
    ["editSample", "sample"],
    ["editMethod", "method"],
    ["editCategory", "category"],
    ["editPrompt", "prompt"],
  ])
    $(id).value = r[key] || "";
  $("activeMetrics").textContent = Object.entries(r.metrics)
    .map(([k, v]) => k + ": " + (v ?? "—"))
    .join(" · ");
  updateSurface();
}
function updateSurface() {
  const old = records.find((r) => r.id === active)?.surface_path || "";
  $("surface").replaceChildren(
    new Option(t("unpaired"), ""),
    ...records
      .filter((r) => r.id !== active && !["splat", "ksplat"].includes(r.format))
      .map((r) => new Option(r.path, r.path)),
  );
  $("surface").value = old;
}
function settingsUI() {
  for (const [k, value] of Object.entries(settings)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = value;
    else
      el.value = typeof value === "number" ? Number(value.toFixed(3)) : value;
  }
  $("syncCamera").checked = settings.sync;
  document
    .querySelectorAll("[data-pass]")
    .forEach((el) => (el.checked = settings.passes.includes(el.dataset.pass)));
}
function changeSettings(id) {
  const old = { ...settings },
    el = $(id);
  const boolean = el.type === "checkbox",
    numeric = typeof DEFAULTS[id] === "number";
  const value = boolean ? el.checked : numeric ? Number(el.value) : el.value;
  try {
    settings = cleanSettings({ ...settings, [id]: value });
    for (const v of viewports) {
      v.view.setSettings(settings);
      if (["azimuth", "elevation", "distance"].includes(id))
        v.view.pose(settings.azimuth, settings.elevation, settings.distance);
      updateViewNote(v);
    }
    if (viewports[0]) cameraState = viewports[0].view.cameraRecord();
    persist();
  } catch (e) {
    settings = old;
    settingsUI();
    status(e.message, true);
  }
}
async function makeProject(hash = false) {
  const assets = records.map((r) => ({ ...r }));
  if (hash)
    for (let i = 0; i < assets.length; i++) {
      status(msg("hashProgress", { current: i + 1, total: assets.length }));
      assets[i].sha256 = await sha256(files.get(assets[i].path));
    }
  const project = await projectRecord(
    assets,
    settings,
    Object.fromEntries(
      viewports.map((v) => [v.record.path, v.view.cameraRecord()]),
    ),
    workspaceName,
  );
  project.selected = [...selected];
  project.collection = collectionRecord();
  project.comparison = { ids: comparisonIds, page: comparisonPage };
  return project;
}
async function restorePending() {
  const p = pendingProject;
  if (!p) return;
  const collection = validateCollection(p.collection);
  if (collection) {
    collectionLayout = collection.layout;
    matchRule = collection.rule;
    disabledGroups = new Set(collection.disabled);
    for (const source of sources) {
      const saved = collection.sources.find((d) => d.id === source.id);
      if (saved) source.depth = saved.depth;
    }
  }
  settings = cleanSettings(p.settings);
  selected = new Set((p.selected || []).filter((path) => files.has(path)));
  settingsUI();
  let missing = 0,
    changed = [];
  for (const saved of p.assets) {
    const r = records.find((r) => r.path === saved.path);
    if (!r) {
      missing++;
      continue;
    }
    if (saved.sha256 && (await sha256(files.get(r.path))) !== saved.sha256) {
      changed.push(r.path);
      continue;
    }
    Object.assign(r, saved, {
      id: r.path,
      size: files.get(r.path).size,
      modified: files.get(r.path).lastModified,
    });
  }
  restoreNotice =
    changed.length || missing
      ? () =>
          [
            changed.length
              ? t("changedFiles", { names: changed.join(", ") })
              : "",
            missing ? t("missingModels", { count: missing }) : "",
          ]
            .filter(Boolean)
            .join(" · ")
      : "";
  if (restoreNotice) status(restoreNotice, !!changed.length);
  if (!missing) pendingProject = null;
  const ids = (p.comparison?.ids || Object.keys(p.cameras || {})).filter((id) =>
    records.some((r) => r.id === id),
  );
  if (ids.length) {
    cameraState = p.cameras[ids[0]];
    await openViews(ids, p.comparison?.page || 0);
    for (const v of viewports)
      if (p.cameras[v.record.path])
        v.view.applyCamera(p.cameras[v.record.path]);
  }
  return { missing, changed };
}
async function loadProjectFile(file) {
  if (extension(file.name) === "zip") {
    const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!zip["project.json"]) throw i18nError("noProjectJson");
    const p = validateProject(JSON.parse(strFromU8(zip["project.json"])));
    const map = new Map();
    for (const [key, bytes] of Object.entries(zip))
      if (key.startsWith("files/") && !key.endsWith("/")) {
        const path = normalizePath(key.slice(6));
        map.set(
          path,
          new File([bytes], path.split("/").at(-1), {
            lastModified: p.assets.find((r) => r.path === path)?.modified || 0,
          }),
        );
      }
    pendingProject = p;
    validateCollection(p.collection);
    await applyFiles(map, p.workspace || file.name, {
      descriptors: p.collection?.sources,
    });
  } else {
    pendingProject = validateProject(JSON.parse(await file.text()));
    const collection = validateCollection(pendingProject.collection);
    if (collection) {
      const restored = collection.sources.map((d) => {
        const current = sources.find(
          (s) => s.id === d.id && s.prefix === d.prefix && s.label === d.label,
        );
        return {
          ...d,
          files: current?.files || new Map(),
          handle: current?.handle || null,
        };
      });
      await commitSources(restored, { replace: true, readMetadata: false });
      await rememberSources();
      return;
    }
    const report = await restorePending();
    setWorkspaceUI();
    renderGallery();
    status(restoreNotice || msg("projectRestored"), !!report?.changed?.length);
  }
}
async function loadDemo() {
  status(msg("loadingDemo"));
  const paths = await (await fetch("./demo/files.json")).json(),
    map = new Map();
  for (const path of paths) {
    const response = await fetch("./demo/" + path);
    if (!response.ok) throw i18nError("demoResource");
    map.set(
      path,
      new File([await response.blob()], path.split("/").at(-1), {
        lastModified: Date.UTC(2026, 8, 1) + map.size * 86400000,
      }),
    );
  }
  metadata = [];
  pendingProject = null;
  disabledGroups.clear();
  await applyFiles(map, "Demo collection");
  tab("library");
}
$("openWorkspace").onclick = guard(() => openDirectory());
$("appendWorkspace").onclick = guard(() => openDirectory(true));
$("addFiles").onclick = () => $("filesInput").click();
$("refreshWorkspace").onclick = guard(() => rescan());
$("filesInput").onchange = guard(async (e) => {
  const next = fileListMap(e.target.files);
  if (!next.size) return;
  const manual = sources.find(
    (s) => ["Manual import", "手动导入"].includes(s.label) && !s.handle,
  );
  if (manual) {
    for (const [path, file] of next) {
      if (manual.files.has(path)) throw i18nError("duplicateFile", { path });
    }
    await applyFiles(new Map([...manual.files, ...next]), manual.label, {
      target: manual.id,
    });
  } else await applyFiles(next, "Manual import", { append: true });
  e.target.value = "";
});
for (const id of ["directoryInput", "appendDirectoryInput"])
  $(id).onchange = guard(async (e) => {
    if (!e.target.files.length) return;
    const name = e.target.files[0].webkitRelativePath.split("/")[0];
    await applyFiles(fileListMap(e.target.files), name, {
      append: id === "appendDirectoryInput",
      target: pendingDirectoryTarget,
    });
    pendingDirectoryTarget = null;
    e.target.value = "";
  });
$("reconnect").onclick = guard(async () => {
  const saved = await recallHandle();
  const list = Array.isArray(saved)
    ? saved
    : saved
      ? [
          {
            id: "workspace-1",
            label: saved.name,
            prefix: "",
            depth: 1,
            handle: saved,
          },
        ]
      : [];
  if (!list.some((s) => s.handle)) throw i18nError("noSavedFolders");
  const next = [];
  const failures = [];
  for (const source of list) {
    const existing = sources.find((s) => s.id === source.id);
    let localFiles = existing?.files || new Map();
    try {
      if (source.handle) {
        if (
          (await source.handle.requestPermission({ mode: "read" })) !==
          "granted"
        )
          throw i18nError("notAuthorized");
        localFiles = await scanDirectory(source.handle);
      }
    } catch {
      failures.push(source.label);
    }
    next.push({ ...source, files: localFiles });
  }
  await commitSources(next);
  if (failures.length)
    status(msg("unauthorizedFolders", { names: failures.join(", ") }), true);
});
$("workspaceSources").onchange = guard(async (e) => {
  const id = e.target.dataset.sourceDepth;
  if (!id || busy) return;
  const source = sources.find((s) => s.id === id);
  source.depth = Number(e.target.value);
  renderGallery();
  persist();
  await rememberSources();
});
$("workspaceSources").onclick = guard(async (e) => {
  if (busy) return;
  const remove = e.target.closest("[data-remove-source]");
  const update = e.target.closest("[data-update-source]");
  if (remove) {
    pendingProject = null;
    await commitSources(
      sources.filter((s) => s.id !== remove.dataset.removeSource),
    );
    await rememberSources();
  } else if (update) await openDirectory(true, update.dataset.updateSource);
});
$("collectionLayout").onchange = () => {
  collectionLayout = $("collectionLayout").value;
  limit = 48;
  renderGallery();
  persist();
};
$("matchRule").onchange = () => {
  matchRule = $("matchRule").value;
  limit = 48;
  renderGallery();
  persist();
};
$("groupChoices").onchange = (e) => {
  if (!e.target.dataset.group) return;
  e.target.checked
    ? disabledGroups.delete(e.target.dataset.group)
    : disabledGroups.add(e.target.dataset.group);
  renderGallery();
  persist();
};
$("comparePrevious").onclick = guard(() =>
  openViews(comparisonIds, comparisonPage - 1),
);
$("compareNext").onclick = guard(() =>
  openViews(comparisonIds, comparisonPage + 1),
);
for (const id of ["demoButton", "emptyDemo"]) $(id).onclick = guard(loadDemo);
$("folderTree").onclick = (e) => {
  const b = e.target.closest("[data-folder]");
  if (b) {
    folder = b.dataset.folder;
    setWorkspaceUI();
    renderGallery();
  }
};
for (const id of ["category", "sort", "metric", "ours", "base", "sign"])
  $(id).onchange = () => {
    limit = 48;
    renderGallery();
  };
$("search").oninput = () => {
  limit = 48;
  renderGallery();
};
$("sortDirection").onclick = () => {
  descending = !descending;
  $("sortDirection").textContent = descending
    ? t("descending")
    : t("ascending");
  renderGallery();
};
$("moreModels").onclick = () => {
  limit += 48;
  renderGallery();
};
$("gallery").onchange = (e) => {
  const p = e.target.dataset.select;
  if (p) {
    e.target.checked ? selected.add(p) : selected.delete(p);
    updateSelection();
  }
};
$("gallery").onclick = guard(async (e) => {
  const rowButton = e.target.closest("[data-compare-row], [data-select-row]");
  if (rowButton && !busy) {
    const index = Number(
      rowButton.dataset.compareRow ?? rowButton.dataset.selectRow,
    );
    const row = matchedRows[index];
    if (!row) return;
    if (rowButton.dataset.compareRow !== undefined)
      await openViews(row.records.map((r) => r.id));
    else {
      for (const r of row.records) selected.add(r.id);
      renderGallery();
    }
    return;
  }
  const b = e.target.closest("[data-preview]");
  if (b) {
    if (busy) return;
    await openViews([b.dataset.preview]);
  }
});
$("selectVisible").onclick = () => {
  const ids = new Set(getFiltered().map((r) => r.id));
  const groups = buildGroups(records, sources).filter(
    (g) => !disabledGroups.has(g.id),
  );
  const available = new Set(groups.flatMap((g) => g.records.map((r) => r.id)));
  selected = new Set([...ids].filter((id) => available.has(id)));
  if (collectionLayout === "matched")
    for (const row of matchedRows)
      for (const r of row.records) selected.add(r.id);
  renderGallery();
};
$("clearSelection").onclick = () => {
  selected.clear();
  renderGallery();
};
$("compareSelected").onclick = guard(async () => {
  if (selected.size > 4)
    status(msg("comparisonAdded", { count: selected.size }));
  await openViews([...selected]);
});
$("libraryTab").onclick = () => tab("library");
$("compareTab").onclick = () => tab("compare");
$("syncCamera").onchange = (e) => {
  settings.sync = e.target.checked;
  if (settings.sync && viewports.length) {
    cameraState =
      viewports.find((v) => v.record.id === active)?.view.cameraRecord() ||
      viewports[0].view.cameraRecord();
    for (const v of viewports) v.view.applyCamera(cameraState);
  }
  persist();
};
$("fitView").onclick = () => {
  for (const v of viewports) v.view.fit();
  persist();
};
$("resetView").onclick = () => {
  settings.azimuth = 30;
  settings.elevation = 20;
  settings.distance = 3.2;
  settingsUI();
  for (const v of viewports) {
    v.view.controls.target.set(0, 0, 0);
    v.view.pose(30, 20, 3.2);
  }
  cameraState = viewports[0]?.view.cameraRecord();
  persist();
};
for (const id of Object.keys(DEFAULTS)) {
  if ($(id) && id !== "passes" && id !== "sync")
    $(id).onchange = () => changeSettings(id);
}
for (const az of [0, 45, 90, 180, 270]) {
  const b = document.createElement("button");
  b.textContent = az + "°";
  b.onclick = () => {
    $("azimuth").value = az;
    changeSettings("azimuth");
  };
  $("presetViews").append(b);
}
for (const pass of MODES) {
  const label = document.createElement("label");
  label.className = "check";
  label.innerHTML = `<input type="checkbox" data-pass="${pass}" ${settings.passes.includes(pass) ? "checked" : ""}><span data-i18n="${pass}">${t(pass)}</span>`;
  label.querySelector("input").onchange = () => {
    settings.passes = [...document.querySelectorAll("[data-pass]:checked")].map(
      (x) => x.dataset.pass,
    );
    persist();
  };
  $("passChoices").append(label);
}
$("autoLight").onclick = () => {
  settings.mode = "relight";
  settings.intensity = 1;
  settings.exposure = 1;
  settingsUI();
  for (const v of viewports) {
    v.view.setSettings(settings);
    updateViewNote(v);
  }
  status(msg("lightEnabled"));
  persist();
};
for (const id of ["up", "rotateX", "rotateY", "rotateZ", "modelScale"])
  $(id).onchange = () => {
    const r = records.find((r) => r.id === active);
    if (!r) return;
    const rotation = ["rotateX", "rotateY", "rotateZ"].map((k) =>
        Number($(k).value),
      ),
      scale = Number($("modelScale").value);
    if (
      !rotation.every(finite) ||
      !finite(scale) ||
      scale <= 0 ||
      scale > 10000
    ) {
      status(msg("invalidTransformInput"), true);
      return;
    }
    Object.assign(r, { up: $("up").value, rotation, scale });
    const vp = viewports.find((v) => v.record.id === active);
    vp?.view.transform();
    vp?.view.draw();
    const u = thumbs.get(r.id);
    if (u) URL.revokeObjectURL(u);
    thumbs.delete(r.id);
    persist();
  };
for (const [id, key] of [
  ["editSample", "sample"],
  ["editMethod", "method"],
  ["editCategory", "category"],
  ["editPrompt", "prompt"],
])
  $(id).onchange = () => {
    const r = records.find((r) => r.id === active);
    if (!r) return;
    r[key] = $(id).value;
    setWorkspaceUI();
    renderGallery();
    persist();
    status(msg("metadataUpdated"));
  };
$("surface").onchange = guard(async () => {
  const r = records.find((r) => r.id === active);
  if (!r) return;
  r.surface_path = $("surface").value;
  const v = viewports.find((v) => v.record.id === active);
  if (v) {
    const pose = v.view.cameraRecord();
    await v.view.load(r, files);
    v.view.applyCamera(pose);
    updateViewNote(v);
  }
  persist();
});
$("saveCamera").onclick = () => {
  const v = viewports.find((v) => v.record.id === active);
  if (!v) return status(msg("openModelFirst"));
  download(
    jsonBlob({
      schema: "research-3d-camera/v1",
      camera: v.view.cameraRecord(),
    }),
    "camera.r3d.json",
  );
};
$("loadCamera").onclick = () => $("cameraInput").click();
$("cameraInput").onchange = guard(async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const p = JSON.parse(await f.text());
  const c = p.camera;
  if (
    p.schema !== "research-3d-camera/v1" ||
    !c ||
    !["position", "target", "up"].every(
      (k) => Array.isArray(c[k]) && c[k].length === 3 && c[k].every(finite),
    )
  )
    throw i18nError("invalidCamera");
  settings = cleanSettings({
    ...settings,
    projection: c.projection,
    fov: c.fov,
    orthoSpan: c.orthoSpan,
  });
  settingsUI();
  for (const v of viewports) {
    v.view.setSettings(settings);
    v.view.applyCamera(c);
  }
  cameraState = c;
  persist();
  e.target.value = "";
  status(msg("cameraRestored"));
});
$("saveProject").onclick = guard(async () => {
  toggleBusy(true);
  try {
    download(jsonBlob(await makeProject(true)), "workspace.r3d.json");
    status(msg("projectSaved"));
  } finally {
    toggleBusy(false);
  }
});
$("packProject").onclick = guard(async () => {
  if (!files.size) throw i18nError("connectModels");
  toggleBusy(true);
  try {
    const project = await makeProject(true),
      entries = { "project.json": strToU8(JSON.stringify(project, null, 2)) };
    let n = 0;
    for (const [path, file] of files) {
      status(msg("packingWorkspace", { current: ++n, total: files.size }));
      entries["files/" + path] = new Uint8Array(await file.arrayBuffer());
    }
    download(
      new Blob([zipSync(entries, { level: 0 })], { type: "application/zip" }),
      "workspace.r3d.zip",
    );
    status(msg("portableSaved"));
  } finally {
    toggleBusy(false);
  }
});
$("loadProject").onclick = () => $("projectInput").click();
$("projectInput").onchange = guard(async (e) => {
  if (e.target.files[0]) await loadProjectFile(e.target.files[0]);
  e.target.value = "";
});
$("importMetrics").onclick = () => $("metricsInput").click();
$("metricsInput").onchange = guard(async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  metadata = parseMetadata(await file.text(), extension(file.name));
  mergeMetadata();
  updateMetricOptions();
  renderGallery();
  persist();
  status(
    msg("metricsImported", {
      count: metadata.length,
      models: metadata.filter((m) => records.some((r) => r.path === m.path))
        .length,
    }),
  );
  e.target.value = "";
});
$("metadataTemplate").onclick = () =>
  download(
    new Blob(
      [
        'path,sample,method,category,prompt,clip,ulip2,surface_path\nours/chair.glb,chair,ours,furniture,"A wooden chair",0.32,0.25,\nbase/chair.glb,chair,base,furniture,"A wooden chair",0.28,0.21,\n',
      ],
      { type: "text/csv;charset=utf-8" },
    ),
    "metrics-template.csv",
  );
$("exportCurrent").onclick = guard(async () => {
  const v = viewports.find((v) => v.record.id === active);
  if (!v) throw i18nError("previewModel");
  if (!v.view.supported(settings.mode)) throw i18nError("unsupportedPass");
  toggleBusy(true);
  try {
    const blob = await v.view.capture(settings.mode, settings.size);
    download(
      blob,
      `${safeName(v.record.stem)}__${settings.mode}__${settings.size}.png`,
    );
    status(
      msg("pngExported", { size: settings.size, pass: msg(settings.mode) }),
    );
  } finally {
    toggleBusy(false);
  }
});
$("exportBatch").onclick = guard(async () => {
  toggleBusy(true);
  cancelExport = false;
  $("progressDialog").showModal();
  let result;
  try {
    result = await exportBatch({
      records: [...selected]
        .map((id) => records.find((r) => r.id === id))
        .filter(Boolean),
      files,
      settings: { ...settings },
      camera: cameraState,
      onProgress: (current, total, text) => {
        $("exportProgress").max = total;
        $("exportProgress").value = current;
        $("exportStatus").textContent = text;
      },
      cancelled: () => cancelExport,
    });
    download(result.blob, "research-figures.zip");
    status(
      msg("batchExported", {
        count: result.manifest.images.length,
        skipped: result.manifest.skipped.length,
      }),
    );
  } finally {
    $("progressDialog").close();
    toggleBusy(false);
  }
});
$("cancelExport").onclick = () => {
  cancelExport = true;
  $("exportStatus").textContent = t("cancelAfterImage");
};
$("progressDialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  cancelExport = true;
});
$("helpButton").onclick = () => $("helpDialog").showModal();
$("language").onchange = () => {
  setLanguage($("language").value);
  refreshLanguage();
};
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    dragDepth++;
    $("dropOverlay").hidden = false;
  }
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) $("dropOverlay").hidden = true;
});
window.addEventListener(
  "drop",
  guard(async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    const list = e.dataTransfer.files;
    if (list.length === 1 && /\.r3d\.(json|zip)$/.test(list[0].name))
      return loadProjectFile(list[0]);
    const roots = [...e.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter(Boolean);
    const name =
      roots.length === 1 && roots[0].isDirectory
        ? roots[0].name
        : "Dropped workspace";
    const map = await droppedFiles(e.dataTransfer.items, list);
    await applyFiles(map, name, { append: sources.length > 0 });
  }),
);
setInterval(() => {
  if (
    sources.some((s) => s.handle) &&
    $("autoRefresh").checked &&
    !document.hidden
  )
    void guard(() => rescan(true))();
}, 15000);
window.addEventListener("focus", () => {
  if (sources.some((s) => s.handle) && $("autoRefresh").checked)
    void guard(() => rescan(true))();
});
window.addEventListener("beforeunload", persist);
translatePage();
settingsUI();
setWorkspaceUI();
renderGallery();
renderStatus();
try {
  const saved = localStorage.getItem("r3d-session");
  if (saved) {
    pendingProject = validateProject(JSON.parse(saved));
    const collection = validateCollection(pendingProject.collection);
    if (collection) {
      sources = collection.sources.map((d) => ({
        ...d,
        files: new Map(),
        handle: null,
      }));
      collectionLayout = collection.layout;
      matchRule = collection.rule;
      disabledGroups = new Set(collection.disabled);
      setWorkspaceUI();
      renderGallery();
    }
    settings = pendingProject.settings;
    settingsUI();
    status(msg("previousSettings"));
  }
} catch {
  localStorage.removeItem("r3d-session");
}
recallHandle()
  .then((h) => {
    $("reconnect").hidden = Array.isArray(h) ? !h.some((s) => s.handle) : !h;
  })
  .catch(() => {});
