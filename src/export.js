import { t, localizedError as i18nError } from "./i18n.js";
import { zipSync, strToU8 } from "fflate";
import { Viewport } from "./viewport.js";
import { parseAngles, safeName, escapeHTML, sha256 } from "./core.js";
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const jsonBlob = (value) =>
  new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
export async function projectRecord(records, settings, cameras, workspaceName) {
  return {
    schema: "research-3d-studio/v1",
    app_version: "0.3.1",
    created_at: new Date().toISOString(),
    workspace: workspaceName,
    settings: { ...settings },
    cameras,
    assets: records.map((r) => ({ ...r })),
  };
}
async function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
export function editableSheet(items, settings) {
  const size = settings.size,
    pad = settings.padding,
    cols = Math.min(settings.columns, Math.max(items.length, 1)),
    labelH = settings.labels ? 34 : 0,
    titleH = settings.caption ? 54 : 0,
    rows = Math.ceil(items.length / cols),
    width = cols * (size + pad) + pad,
    height = rows * (size + labelH + pad) + pad + titleH;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeHTML(settings.caption || "Research 3D comparison")}</title>`;
  if (settings.caption)
    out += `<text x="${pad}" y="${pad + 28}" font-family="Arial,sans-serif" font-size="24" fill="#263b39">${escapeHTML(settings.caption)}</text>`;
  for (let i = 0; i < items.length; i++) {
    const item = items[i],
      x = pad + (i % cols) * (size + pad),
      y = pad + titleH + Math.floor(i / cols) * (size + labelH + pad);
    out += `<g id="panel-${i + 1}" data-asset="${escapeHTML(item.path)}"><image x="${x}" y="${y}" width="${size}" height="${size}" xlink:href="${item.data}"/>`;
    if (settings.labels)
      out += `<text x="${x + size / 2}" y="${y + size + 24}" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="#263b39">${escapeHTML(item.label)}</text>`;
    out += "</g>";
  }
  return out + "</svg>";
}
export async function exportBatch({
  records,
  files,
  settings,
  camera,
  onProgress = () => {},
  cancelled = () => false,
}) {
  if (!records.length) throw i18nError("selectExportModels");
  if (!settings.passes.length) throw i18nError("selectExportPasses");
  const angles = settings.multiView ? parseAngles(settings.views) : [null],
    total = records.length * angles.length * settings.passes.length;
  if (total * settings.size * settings.size * 4 > 1024 ** 3)
    throw i18nError("exportBudget");
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:256px;height:256px";
  document.body.append(host);
  const view = new Viewport(host, settings, { interactive: false }),
    entries = {},
    sheets = new Map(),
    manifest = {
      schema: "research-3d-studio-export/v1",
      version: "0.3.1",
      created_at: new Date().toISOString(),
      settings,
      renderer: {
        three: "0.160.1",
        gaussianSplats3D: "0.4.7",
        device: navigator.userAgent,
      },
      conventions: {
        normal:
          "camera/view +X right +Y up +Z toward viewer; RGB=(N+1)/2, no display color conversion",
        depth:
          "8-bit linear camera-space Z: z=gray/255*(far-near)+near; values clipped; units follow recorded model transform",
        mask: "white foreground, alpha=coverage; surface geometry for mesh passes",
        color: "base color / vertex colors, unlit, sRGB output",
        relight:
          "three directional lights + hemisphere; surface material, ACES tone mapping, sRGB output",
        alpha:
          "transparent background, PNG straight alpha; background setting is preview-only",
      },
      images: [],
      skipped: [],
    };
  let count = 0;
  try {
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (cancelled()) throw i18nError("exportCancelled");
      onProgress(count, total, t("loadingAsset", { name: record.name }));
      try {
        await view.load(record, files);
      } catch (e) {
        for (const angle of angles)
          for (const pass of settings.passes) {
            manifest.skipped.push({
              path: record.path,
              pass,
              angle,
              reason: e.message,
            });
            count++;
          }
        continue;
      }
      if (camera) view.applyCamera(camera);
      else view.fit();
      const hash = await sha256(files.get(record.path));
      for (const angle of angles) {
        if (angle !== null)
          view.pose(angle, settings.elevation, settings.distance);
        for (const pass of settings.passes) {
          if (cancelled()) throw i18nError("exportCancelled");
          onProgress(
            count,
            total,
            `${record.name} · ${pass}${angle === null ? "" : ` · ${angle}°`}`,
          );
          if (!view.supported(pass)) {
            manifest.skipped.push({
              path: record.path,
              pass,
              angle,
              reason: record.surface_path
                ? t("meshPassUnavailable")
                : t("noSurfacePass"),
            });
            count++;
            continue;
          }
          const blob = await view.capture(pass, settings.size),
            fileName = `images/${String(index + 1).padStart(3, "0")}__${safeName(record.stem)}__${angle === null ? "current" : `az${angle}`}__${pass}.png`;
          entries[fileName] = new Uint8Array(await blob.arrayBuffer());
          manifest.images.push({
            file: fileName,
            asset: record.path,
            workspace: record.workspaceLabel || null,
            workspace_id: record.workspaceId || null,
            local_path: record.localPath || record.path,
            source_sha256: hash,
            sample: record.sample,
            method: record.method,
            category: record.category,
            prompt: record.prompt,
            metrics: record.metrics,
            pass,
            azimuth: angle,
            camera: view.cameraRecord(),
            model_transform: view.normalization,
            representation: pass === "color" ? view.kind : "mesh",
            surface_path: record.surface_path || null,
            size: [settings.size, settings.size],
          });
          const sheet = sheets.get(pass) || [];
          sheet.push({
            path: record.path,
            label: `${record.method} · ${record.stem}${angle === null ? "" : ` · ${angle}°`}`,
            data: await dataURL(blob),
          });
          sheets.set(pass, sheet);
          count++;
        }
      }
    }
    if (!manifest.images.length)
      throw i18nError("noExportImages", {
        reason: manifest.skipped[0]?.reason || "",
      });
    onProgress(total, total, t("packingFigures"));
    for (const [pass, items] of sheets) {
      const chunkSize = 24;
      for (let i = 0; i < items.length; i += chunkSize)
        entries[`sheets/${pass}__${1 + i / chunkSize}.svg`] = strToU8(
          editableSheet(items.slice(i, i + chunkSize), settings),
        );
    }
    entries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
    entries["README.txt"] = strToU8(
      "Independent PNG files are in images/. Editable transparent SVG contact sheets are in sheets/. Layout text and panels remain separate SVG elements. Rendering configuration, data conventions, source hashes and unavailable passes are recorded in manifest.json. Gaussian surface passes use an explicitly paired mesh. No training or scientific metric inference is performed.",
    );
    return {
      blob: new Blob([zipSync(entries, { level: 0 })], {
        type: "application/zip",
      }),
      manifest,
    };
  } finally {
    await view.dispose();
    host.remove();
  }
}
