import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { unzipSync, strFromU8 } from "fflate";
const root = path.resolve(".");
// Keep the existing workflow suite in Chinese; i18n.spec.js covers the English default.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("r3d-language", "zh"));
});
async function dl(page, action) {
  const promise = page.waitForEvent("download");
  await action();
  return fs.readFile(await (await promise).path());
}
function alphaCheck(buffer) {
  const p = PNG.sync.read(Buffer.from(buffer));
  let empty = 0,
    solid = 0,
    edge = 0;
  for (let i = 3; i < p.data.length; i += 4) {
    if (p.data[i] === 0) empty++;
    else if (p.data[i] === 255) solid++;
    else edge++;
  }
  expect(empty).toBeGreaterThan(0);
  expect(solid + edge).toBeGreaterThan(20);
  return p;
}
async function demo(page) {
  await page.goto("/");
  await page.locator("#demoButton").click();
  await expect(page.locator(".model-card")).toHaveCount(8);
  await expect(page.locator(".model-card .thumb img")).toHaveCount(8, {
    timeout: 90000,
  });
}
test("workspace gallery, metadata delta, synchronized camera, relighting, project restore and figure ZIP", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await demo(page);
  await page.screenshot({ path: "test-results/gallery.png", fullPage: true });
  await page.locator("#collectionLayout").selectOption("grid");
  await page.locator("#sort").selectOption("modified");
  const dates = await page
    .locator(".model-card")
    .evaluateAll((es) => es.map((e) => e.dataset.id));
  expect(dates[0]).toBe("ours/chair.glb");
  await page.locator("#sortDirection").click();
  expect(
    await page.locator(".model-card").first().getAttribute("data-id"),
  ).toBe("base/knot.glb");
  await page.locator("#sort").selectOption("delta");
  await page.locator("#metric").selectOption("clip");
  await expect(page.locator(".card-metric").first()).toContainText("+0.0180");
  await page.locator("#sign").selectOption("negative");
  await expect(page.locator(".model-card")).toHaveCount(0);
  await page.locator("#sign").selectOption("all");
  await page.locator('[data-select="ours/chair.glb"]').check();
  await page.locator('[data-select="base/chair.glb"]').check();
  await page.locator("#compareSelected").click();
  await expect(
    page.locator(".viewport-note").filter({ hasText: "triangles" }),
  ).toHaveCount(2);
  await page.locator("#azimuth").fill("75");
  await page.locator("#azimuth").dispatchEvent("change");
  await page.locator("#size").selectOption("512");
  const color = await dl(page, () => page.locator("#exportCurrent").click());
  expect(alphaCheck(color).width).toBe(512);
  await page.locator("#autoLight").click();
  const relit = await dl(page, () => page.locator("#exportCurrent").click());
  alphaCheck(relit);
  expect(Buffer.compare(color, relit)).not.toBe(0);
  const camera1 = JSON.parse(
    (await dl(page, () => page.locator("#saveCamera").click())).toString(),
  );
  await page.locator(".viewport-title").nth(1).click();
  const camera2 = JSON.parse(
    (await dl(page, () => page.locator("#saveCamera").click())).toString(),
  );
  expect(camera1.camera.position).toEqual(camera2.camera.position);
  await page.locator("#mode").selectOption("normal");
  const normal = await dl(page, () => page.locator("#exportCurrent").click());
  alphaCheck(normal);
  expect(Buffer.compare(normal, color)).not.toBe(0);
  const project = await dl(page, () => page.locator("#saveProject").click());
  const parsed = JSON.parse(project);
  expect(parsed.assets).toHaveLength(8);
  expect(parsed.assets.every((r) => r.sha256?.length === 64)).toBeTruthy();
  await page.locator("#azimuth").fill("10");
  await page.locator("#azimuth").dispatchEvent("change");
  await page.locator("#projectInput").setInputFiles({
    name: "workspace.r3d.json",
    mimeType: "application/json",
    buffer: project,
  });
  await expect(page.locator("#azimuth")).toHaveValue("75");
  await page.locator("#multiView").check();
  await page.locator("#views").fill("0,90");
  await page.locator("#views").dispatchEvent("change");
  await page.locator('[data-pass="mask"]').check();
  const zip = unzipSync(
    await dl(page, () => page.locator("#exportBatch").click()),
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  expect(manifest.images).toHaveLength(12);
  expect(manifest.skipped).toHaveLength(0);
  expect(Object.keys(zip).filter((k) => k.endsWith(".svg"))).toHaveLength(3);
  for (const im of manifest.images) {
    alphaCheck(zip[im.file]);
    expect(im.source_sha256).toHaveLength(64);
    expect(im.camera.position).toHaveLength(3);
  }
  const sheet = strFromU8(zip["sheets/color__1.svg"]);
  expect(sheet).toContain('<g id="panel-1"');
  expect(sheet).toContain("<text");
  await page.screenshot({
    path: "test-results/comparison.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("folder snapshot recursively resolves OBJ materials and textures; PLY, STL and Gaussian imports work", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .locator("#directoryInput")
    .setInputFiles(path.join(root, "tests/fixtures"));
  await expect(page.locator(".model-card")).toHaveCount(5);
  await page.locator('[data-preview="triangle.obj"]').click();
  await expect(page.locator(".viewport-note")).toContainText("triangles");
  await page.locator("#size").selectOption("512");
  const image = alphaCheck(
    await dl(page, () => page.locator("#exportCurrent").click()),
  );
  let red = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i + 3] > 250 && image.data[i] > image.data[i + 1] * 2) red++;
  expect(red).toBeGreaterThan(100);
  await page.locator("#libraryTab").click();
  await page.locator('[data-preview="mesh.ply"]').click();
  await expect(page.locator(".viewport-note")).toContainText("4 triangles");
  await page.locator("#libraryTab").click();
  await page.locator('[data-preview="triangle.stl"]').click();
  await expect(page.locator(".viewport-note")).toContainText("1 triangles");
  await page.locator("#libraryTab").click();
  await page.locator('[data-preview="sphere.splat"]').click();
  await expect(page.locator(".viewport-note")).toContainText("Gaussian", {
    timeout: 90000,
  });
  alphaCheck(await dl(page, () => page.locator("#exportCurrent").click()));
  await page.locator("#autoLight").click();
  await expect(page.locator(".viewport-note")).toContainText("需要表面网格");
  await page.locator("#mode").selectOption("color");
  const portable = await dl(page, () => page.locator("#packProject").click());
  const zip = unzipSync(portable);
  expect(zip["files/texture.png"]).toBeTruthy();
  await page.locator("#demoButton").click();
  await expect(page.locator(".model-card")).toHaveCount(8);
  await page.locator("#projectInput").setInputFiles({
    name: "workspace.r3d.zip",
    mimeType: "application/zip",
    buffer: portable,
  });
  await expect(page.locator(".model-card")).toHaveCount(5);
  expect(errors).toEqual([]);
});
test("manual file import, drag/drop and zero-result state", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("#filesInput")
    .setInputFiles([
      path.join(root, "public/demo/ours/chair.glb"),
      path.join(root, "public/demo/base/vase.glb"),
    ]);
  await expect(page.locator(".model-card")).toHaveCount(2);
  await page.locator("#search").fill("does-not-exist");
  await expect(page.locator(".model-card")).toHaveCount(0);
  await expect(page.locator("#resultCount")).toContainText("0 个模型");
  await page.locator("#search").fill("");
  // Exercise the actual drop handler with browser File objects, not an application hook.
  const body = await fs.readFile(
    path.join(root, "tests/fixtures/mesh.ply"),
    "utf8",
  );
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([text], "dropped.ply", { type: "application/octet-stream" }),
    );
    window.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, body);
  await expect(page.locator(".model-card")).toHaveCount(3);
  await page.locator('[data-preview$="/dropped.ply"]').click();
  await expect(page.locator(".viewport-note")).toContainText("4 triangles");
});
test("data pass conventions and external glTF sidecars", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("#directoryInput")
    .setInputFiles(path.join(root, "tests/fixtures"));
  await page.locator('[data-preview="triangle.obj"]').click();
  await expect(page.locator(".viewport-note")).toContainText("triangles");
  for (const [id, val] of [
    ["azimuth", "0"],
    ["elevation", "0"],
    ["distance", "3.2"],
  ]) {
    await page.locator("#" + id).fill(val);
    await page.locator("#" + id).dispatchEvent("change");
  }
  await page.locator("#size").selectOption("512");
  const pixel = async (mode) => {
    await page.locator("#mode").selectOption(mode);
    const p = alphaCheck(
      await dl(page, () => page.locator("#exportCurrent").click()),
    );
    const offset = 4 * (256 * 512 + 256);
    return [...p.data.subarray(offset, offset + 4)];
  };
  const normal = await pixel("normal");
  expect(Math.abs(normal[0] - 128)).toBeLessThanOrEqual(1);
  expect(Math.abs(normal[1] - 128)).toBeLessThanOrEqual(1);
  expect(normal[2]).toBe(255);
  expect(normal[3]).toBe(255);
  const depth = await pixel("depth");
  expect(
    Math.abs(depth[0] - Math.round(((3.2 - 0.1) / (8 - 0.1)) * 255)),
  ).toBeLessThanOrEqual(1);
  expect(depth.slice(0, 3)).toEqual([depth[0], depth[0], depth[0]]);
  expect(await pixel("mask")).toEqual([255, 255, 255, 255]);
  const glb = await fs.readFile(path.join(root, "public/demo/ours/chair.glb"));
  const len = glb.readUInt32LE(12),
    json = JSON.parse(glb.subarray(20, 20 + len).toString()),
    binary = glb.subarray(28 + len);
  json.buffers[0].uri = "chair.bin";
  await page.locator("#filesInput").setInputFiles([
    {
      name: "sidecar.gltf",
      mimeType: "model/gltf+json",
      buffer: Buffer.from(JSON.stringify(json)),
    },
    { name: "chair.bin", mimeType: "application/octet-stream", buffer: binary },
  ]);
  await page.locator("#libraryTab").click();
  await page.locator('[data-preview$="/sidecar.gltf"]').click();
  await expect(page.locator(".viewport-note")).toContainText("triangles");
});

async function tempCollection() {
  const os = await import("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r3d-collections-"));
  async function put(relative, source = "public/demo/ours/chair.glb") {
    const dest = path.join(dir, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(root, source), dest);
  }
  return {
    dir,
    put,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
test("automatic multi-folder comparison retains incomplete rows, unmatched models and disabled groups in projects", async ({
  page,
}) => {
  const fixture = await tempCollection();
  try {
    for (const name of [
      "base/chair.glb",
      "ours/chair.glb",
      "external/chair.glb",
      "base/vase.glb",
      "ours/vase.glb",
      "base/uniqueBase.glb",
      "ours/uniqueOurs.glb",
      "external/uniqueExternal.glb",
    ])
      await fixture.put("experiment/" + name);
    await page.goto("/");
    await page
      .locator("#directoryInput")
      .setInputFiles(path.join(fixture.dir, "experiment"));
    await expect(page.locator(".model-card")).toHaveCount(8);
    await expect(page.locator(".match-row")).toHaveCount(2);
    await expect(page.locator(".missing-cell")).toHaveCount(1);
    await expect(page.locator(".folder-section")).toHaveCount(3);
    const row = page.locator('[data-match-key="chair.glb"]');
    await expect(row.locator(".model-card")).toHaveCount(3);
    await row.getByRole("button", { name: "对照本行" }).click();
    await expect(
      page.locator(".viewport-note").filter({ hasText: "triangles" }),
    ).toHaveCount(3);
    await page.locator("#libraryTab").click();
    await row.getByRole("button", { name: "加入导出" }).click();
    await expect(page.locator("#selectedCount")).toHaveText("3");
    await page.locator('[data-group="workspace-1:external"]').uncheck();
    await expect(page.locator(".model-card")).toHaveCount(6);
    await page.locator("#collectionLayout").selectOption("folders");
    await expect(page.locator(".match-row")).toHaveCount(0);
    await expect(page.locator(".folder-section")).toHaveCount(2);
    const portable = await dl(page, () => page.locator("#packProject").click());
    const parsed = JSON.parse(strFromU8(unzipSync(portable)["project.json"]));
    expect(parsed.collection.disabled).toEqual(["workspace-1:external"]);
    expect(parsed.collection.layout).toBe("folders");
    await page.locator("#demoButton").click();
    await expect(page.locator('[data-id="ours/knot.glb"]')).toHaveCount(1);
    await page.locator("#projectInput").setInputFiles({
      name: "folders.r3d.zip",
      mimeType: "application/zip",
      buffer: portable,
    });
    await expect(page.locator("#collectionLayout")).toHaveValue("folders");
    await expect(page.locator(".model-card")).toHaveCount(6);
    await page.locator('[data-group="workspace-1:external"]').check();
    await expect(page.locator(".model-card")).toHaveCount(8);
    await page.locator("#collectionLayout").selectOption("matched");
    await expect(page.locator(".model-card .thumb img")).toHaveCount(8, {
      timeout: 30000,
    });
    await page.screenshot({
      path: "test-results/folder-comparison.png",
      fullPage: true,
    });
  } finally {
    await fixture.cleanup();
  }
});
test("five cross-workspace methods retain same-name files, camera paging and portable relative textures", async ({
  page,
}) => {
  const fixture = await tempCollection();
  try {
    const labels = ["ours", "base", "base", "externalA", "externalB"];
    for (let i = 0; i < labels.length; i++) {
      const prefix = `${i}/${labels[i]}`;
      await fixture.put(
        prefix + "/chair.glb",
        i % 2 ? "public/demo/base/chair.glb" : "public/demo/ours/chair.glb",
      );
      if (i < 2)
        for (const name of ["triangle.obj", "triangle.mtl", "texture.png"])
          await fixture.put(prefix + "/" + name, "tests/fixtures/" + name);
    }
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    for (let i = 0; i < labels.length; i++)
      await page
        .locator(i === 0 ? "#directoryInput" : "#appendDirectoryInput")
        .setInputFiles(path.join(fixture.dir, String(i), labels[i]));
    await expect(page.locator(".workspace-source")).toHaveCount(5);
    await expect(page.locator(".model-card")).toHaveCount(7);
    await expect(
      page.locator('[data-match-key="chair.glb"] .model-card'),
    ).toHaveCount(5);
    await page
      .locator('[data-match-key="chair.glb"]')
      .getByRole("button", { name: "对照本行" })
      .click();
    await expect(
      page.locator(".viewport-note").filter({ hasText: "triangles" }),
    ).toHaveCount(4);
    await page.locator("#azimuth").fill("75");
    await page.locator("#azimuth").dispatchEvent("change");
    const first = JSON.parse(
      (await dl(page, () => page.locator("#saveCamera").click())).toString(),
    );
    await page.locator("#compareNext").click();
    await expect(
      page.locator(".viewport-note").filter({ hasText: "triangles" }),
    ).toHaveCount(1);
    await expect(page.locator("#comparePageLabel")).toContainText("5–5 / 5");
    const last = JSON.parse(
      (await dl(page, () => page.locator("#saveCamera").click())).toString(),
    );
    expect(last.camera.position).toEqual(first.camera.position);
    await page.locator("#comparePrevious").click();
    await expect(
      page.locator(".viewport-note").filter({ hasText: "triangles" }),
    ).toHaveCount(4);
    const portable = await dl(page, () => page.locator("#packProject").click());
    const zipped = unzipSync(portable),
      project = JSON.parse(strFromU8(zipped["project.json"]));
    expect(project.collection.sources).toHaveLength(5);
    expect(new Set(project.assets.map((r) => r.path)).size).toBe(7);
    expect(
      Object.keys(zipped).filter((p) => p.endsWith("/chair.glb")),
    ).toHaveLength(5);
    expect(
      Object.keys(zipped).filter((p) => p.endsWith("/texture.png")),
    ).toHaveLength(2);
    await page.locator('[data-remove-source="workspace-2"]').click();
    await expect(page.locator(".workspace-source")).toHaveCount(4);
    await expect(page.locator(".model-card")).toHaveCount(5);
    await page.locator("#projectInput").setInputFiles({
      name: "multiple.r3d.zip",
      mimeType: "application/zip",
      buffer: portable,
    });
    await expect(page.locator(".workspace-source")).toHaveCount(5);
    await expect(page.locator(".model-card")).toHaveCount(7);
    await page.locator("#libraryTab").click();
    const obj = project.assets.find(
      (r) => r.localPath === "triangle.obj" && r.workspaceId === "workspace-2",
    );
    await page.locator(`[data-preview="${obj.path}"]`).click();
    await expect(page.locator(".viewport-note")).toContainText("triangles");
    await page.locator("#size").selectOption("512");
    const image = alphaCheck(
      await dl(page, () => page.locator("#exportCurrent").click()),
    );
    let red = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (image.data[i + 3] > 250 && image.data[i] > image.data[i + 1] * 2)
        red++;
    expect(red).toBeGreaterThan(100);
    expect(errors).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
test("rescanning a connected directory preserves additional snapshot workspaces", async ({
  page,
}) => {
  const fixture = await tempCollection();
  try {
    await fixture.put("base/chair.glb");
    const glb = [
      ...(await fs.readFile(path.join(root, "public/demo/ours/chair.glb"))),
    ];
    await page.goto("/");
    await page.evaluate((bytes) => {
      window.testModelBytes = bytes;
      window.testDirectoryNames = ["chair.glb"];
      window.showDirectoryPicker = async () => ({
        name: "connected",
        kind: "directory",
        async *entries() {
          for (const name of window.testDirectoryNames)
            yield [
              name,
              {
                kind: "file",
                async getFile() {
                  return new File(
                    [new Uint8Array(window.testModelBytes)],
                    name,
                    { lastModified: 123 },
                  );
                },
              },
            ];
        },
      });
    }, glb);
    await page.locator("#openWorkspace").click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    await page
      .locator("#appendDirectoryInput")
      .setInputFiles(path.join(fixture.dir, "base"));
    await expect(page.locator(".model-card")).toHaveCount(2);
    await page.evaluate(() => window.testDirectoryNames.push("new.glb"));
    await page.locator("#refreshWorkspace").click();
    await expect(page.locator(".model-card")).toHaveCount(3);
    await expect(page.locator('[data-id="base/chair.glb"]')).toHaveCount(1);
    await page.evaluate(() => (window.testDirectoryNames = []));
    await page.locator("#refreshWorkspace").click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    await expect(page.locator('[data-id="base/chair.glb"]')).toHaveCount(1);
  } finally {
    await fixture.cleanup();
  }
});

test("JSON project reconnects each workspace independently and scoped snapshot updates preserve the other source", async ({
  page,
}) => {
  const fixture = await tempCollection();
  try {
    await fixture.put("ours/chair.glb");
    await fixture.put("base/chair.glb", "public/demo/base/chair.glb");
    await fs.writeFile(
      path.join(fixture.dir, "base/metrics.csv"),
      "path,sample,method,clip\nchair.glb,chair,base,0.21\n",
    );
    await page.goto("/");
    await page
      .locator("#directoryInput")
      .setInputFiles(path.join(fixture.dir, "ours"));
    await expect(page.locator(".model-card")).toHaveCount(1);
    await page
      .locator("#appendDirectoryInput")
      .setInputFiles(path.join(fixture.dir, "base"));
    await expect(page.locator(".model-card")).toHaveCount(2);
    const project = await dl(page, () => page.locator("#saveProject").click());
    const parsed = JSON.parse(project);
    expect(
      parsed.assets.find((r) => r.path === "base/chair.glb").metrics.clip,
    ).toBe(0.21);
    await page.locator("#demoButton").click();
    await expect(page.locator('[data-id="ours/knot.glb"]')).toHaveCount(1);
    await page.locator("#projectInput").setInputFiles({
      name: "workspace.r3d.json",
      mimeType: "application/json",
      buffer: project,
    });
    await expect(page.locator(".workspace-source")).toHaveCount(2);
    await expect(page.locator(".model-card")).toHaveCount(0);
    await page.evaluate(() => {
      window.showDirectoryPicker = undefined;
    });
    for (const [id, name] of [
      ["workspace-2", "base"],
      ["workspace-1", "ours"],
    ]) {
      const chooser = page.waitForEvent("filechooser");
      await page.locator(`[data-update-source="${id}"]`).click();
      await (await chooser).setFiles(path.join(fixture.dir, name));
      await expect(page.locator(`[data-source="${id}"]`)).toContainText(
        "1 个模型",
      );
    }
    await expect(
      page.locator('[data-match-key="chair.glb"] .model-card'),
    ).toHaveCount(2);
    await fixture.put("base/new.glb", "public/demo/base/vase.glb");
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-update-source="workspace-2"]').click();
    await (await chooser).setFiles(path.join(fixture.dir, "base"));
    await expect(page.locator(".model-card")).toHaveCount(3);
    await expect(page.locator('[data-id="chair.glb"]')).toHaveCount(1);
    await expect(page.locator('[data-id="base/new.glb"]')).toHaveCount(1);
  } finally {
    await fixture.cleanup();
  }
});
