import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath,
  parseCSV,
  parseMetadata,
  deltaIndex,
  sortRecords,
  describe,
  cleanSettings,
  validateProject,
  DEFAULTS,
  parseAngles,
} from "../src/core.js";
import { scanDirectory, indexFiles } from "../src/workspace.js";
test("relative file references normalize correctly without escaping the workspace", () => {
  assert.equal(normalizePath("models/../textures/a.png"), "textures/a.png");
  assert.equal(normalizePath("a\\b.glb"), "a/b.glb");
  assert.throws(() => normalizePath("../secret"));
});
test("CSV supports quoted commas, multiline prompts, zero and explicit missingness", () => {
  const rows = parseMetadata(
    'path,sample,method,prompt,clip,ulip2\na.glb,chair,ours,"a, chair\nwith legs",0,\nb.glb,chair,base,chair,-.1,N/A\n',
    "csv",
  );
  assert.equal(rows[0].prompt, "a, chair\nwith legs");
  assert.equal(rows[0].metrics.clip, 0);
  assert.equal(rows[0].metrics.ulip2, null);
  assert.throws(() => parseCSV("x,x\n1,2"));
  assert.throws(() => parseMetadata("path,clip\na.glb,NaN", "csv"));
});
test("delta pairs by sample and exact method; duplicates, absent values and absent methods stay null", () => {
  const r = [
    { sample: "a", method: "ours", metrics: { clip: 0.3 } },
    { sample: "a", method: "base", metrics: { clip: 0.2 } },
    { sample: "b", method: "ours", metrics: { clip: 0 } },
    { sample: "b", method: "base", metrics: { clip: null } },
    { sample: "c", method: "ours", metrics: { clip: 0.3 } },
    { sample: "c", method: "ours", metrics: { clip: 0.4 } },
    { sample: "c", method: "base", metrics: { clip: 0.1 } },
  ];
  const d = deltaIndex(r, "clip", "ours", "base");
  assert.ok(Math.abs(d.get("a") - 0.1) < 1e-10);
  assert.equal(d.get("b"), null);
  assert.equal(d.get("c"), null);
});
test("stable metric sorting keeps missing values last in both directions; filters compose", () => {
  const records = [
    ["a.glb", 3],
    ["b.glb", null],
    ["c.glb", 0],
    ["d.glb", 3],
  ].map(([path, v]) => ({
    ...describe(path, { size: 1, lastModified: 0 }),
    metrics: { clip: v },
    category: "chairs",
  }));
  assert.deepEqual(
    sortRecords(records, {
      sort: "metric",
      metric: "clip",
      descending: true,
    }).map((r) => r.path),
    ["a.glb", "d.glb", "c.glb", "b.glb"],
  );
  assert.deepEqual(
    sortRecords(records, { sort: "metric", metric: "clip" }).map((r) => r.path),
    ["c.glb", "a.glb", "d.glb", "b.glb"],
  );
  assert.equal(
    sortRecords(records, { query: "a.glb", category: "chairs" }).length,
    1,
  );
});
test("project validation rejects invalid transform, camera settings and traversal", () => {
  const asset = describe("chair.glb", { size: 1, lastModified: 0 });
  assert.equal(
    validateProject({
      schema: "research-3d-studio/v1",
      settings: DEFAULTS,
      assets: [asset],
    }).assets.length,
    1,
  );
  assert.throws(() =>
    validateProject({
      schema: "research-3d-studio/v1",
      settings: DEFAULTS,
      assets: [{ ...asset, scale: -1 }],
    }),
  );
  assert.throws(() => cleanSettings({ depthNear: 5, depthFar: 4 }));
  assert.throws(() => parseAngles("0,,90"));
  assert.deepEqual(parseAngles("0, 90, 180"), [0, 90, 180]);
});
test("recursive workspace scan retains texture sidecars and filters non-models from gallery", async () => {
  const file = (name) => ({
    kind: "file",
    async getFile() {
      return { name, size: 20, lastModified: 100 };
    },
  });
  const dir = (entries) => ({
    kind: "directory",
    async *entries() {
      yield* entries;
    },
  });
  const root = dir([
    [
      "models",
      dir([
        ["chair.obj", file("chair.obj")],
        ["chair.mtl", file("chair.mtl")],
      ]),
    ],
    ["texture.png", file("texture.png")],
    [".git", dir([["a.glb", file("a.glb")]])],
  ]);
  const files = await scanDirectory(root);
  assert.equal(files.size, 3);
  assert.deepEqual(
    indexFiles(files).map((r) => r.path),
    ["models/chair.obj"],
  );
});

test("multiple workspaces namespace identical filenames and keep their resource sidecars", async () => {
  const { newSource, combineSources, indexSources } =
    await import("../src/collections.js");
  const a = newSource(
    new Map([
      ["chair.obj", { size: 10, lastModified: 1 }],
      ["chair.mtl", { size: 20 }],
    ]),
    "base",
  );
  const b = newSource(
    new Map([
      ["chair.obj", { size: 30, lastModified: 2 }],
      ["chair.mtl", { size: 40 }],
    ]),
    "base",
    [a],
  );
  const c = newSource(
    new Map([["chair.obj", { size: 50, lastModified: 3 }]]),
    "base",
    [a, b],
  );
  const sources = [a, b, c];
  assert.equal(combineSources(sources).size, 5);
  assert.equal(new Set(indexSources(sources).map((r) => r.path)).size, 3);
  assert.deepEqual(
    indexSources(sources).map((r) => r.localPath),
    ["chair.obj", "chair.obj", "chair.obj"],
  );
  assert.equal(combineSources(sources).get(b.prefix + "/chair.mtl").size, 40);
  assert.throws(() => combineSources([a, { ...b, prefix: "" }]));
});
test("folder matching keeps stable method columns, missing cells and unmatched assets", async () => {
  const { newSource, indexSources, buildGroups, matchGroups } =
    await import("../src/collections.js");
  const source = newSource(
    new Map(
      [
        "base/chair.glb",
        "ours/chair.glb",
        "external/chair.glb",
        "base/vase.glb",
        "ours/vase.glb",
        "external/unique.glb",
      ].map((p) => [p, { size: 1 }]),
    ),
    "experiment",
  );
  const groups = buildGroups(indexSources([source]), [source]);
  const matches = matchGroups(groups);
  assert.equal(groups.length, 3);
  assert.equal(matches.rows.length, 2);
  assert.equal(
    matches.rows.find((r) => r.key === "chair.glb").records.length,
    3,
  );
  assert.equal(matches.rows.find((r) => r.key === "vase.glb").cells.size, 2);
  assert.equal([...matches.unmatched.values()].flat().length, 1);
  assert.equal(matches.conflicts.size, 0);
});
test("ambiguous names are never auto-paired; relative paths and optional format-independent matching resolve cases explicitly", async () => {
  const { newSource, indexSources, buildGroups, matchGroups } =
    await import("../src/collections.js");
  const source = newSource(
    new Map(
      [
        "base/a/chair.glb",
        "base/b/chair.glb",
        "ours/a/chair.glb",
        "ours/b/chair.glb",
        "base/vase.glb",
        "ours/vase.obj",
      ].map((p) => [p, { size: 1 }]),
    ),
    "experiment",
  );
  const groups = buildGroups(indexSources([source]), [source]);
  assert.equal(matchGroups(groups).rows.length, 0);
  assert.equal(matchGroups(groups).conflicts.size, 4);
  assert.equal(matchGroups(groups, "relative").rows.length, 2);
  assert.equal(matchGroups(groups, "stem").rows.length, 1);
  assert.equal(matchGroups(groups, "stem").rows[0].key, "vase");
  source.depth = 0;
  assert.equal(buildGroups(indexSources([source]), [source]).length, 1);
  source.depth = 2;
  assert.equal(buildGroups(indexSources([source]), [source]).length, 6);
});
test("collection project descriptors preserve IDs and reject malformed mappings", async () => {
  const { validateCollection } = await import("../src/collections.js");
  const p = {
    sources: [{ id: "w1", label: "base", prefix: "", depth: 1 }],
    layout: "matched",
    rule: "name",
    disabled: [],
  };
  assert.equal(validateCollection(p).sources[0].id, "w1");
  assert.throws(() =>
    validateCollection({ ...p, sources: [...p.sources, ...p.sources] }),
  );
  assert.throws(() =>
    validateCollection({
      ...p,
      sources: [{ ...p.sources[0], prefix: "../outside" }],
    }),
  );
  assert.throws(() => validateCollection({ ...p, rule: "guess" }));
});
