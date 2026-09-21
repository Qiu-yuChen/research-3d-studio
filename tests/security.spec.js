import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

test("model sidecars cannot initiate remote HTTP requests", async ({
  page,
}) => {
  const remoteRequests = [];
  await page.route("https://example.invalid/**", async (route) => {
    remoteRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  const glb = await fs.readFile("public/demo/ours/chair.glb");
  const length = glb.readUInt32LE(12);
  const model = JSON.parse(glb.subarray(20, 20 + length).toString());
  model.buffers[0].uri = "https://example.invalid/model.bin";
  await page.locator("#filesInput").setInputFiles({
    name: "remote.gltf",
    mimeType: "model/gltf+json",
    buffer: Buffer.from(JSON.stringify(model)),
  });
  await expect(page.locator(".model-card .error")).toContainText(/network/i);
  await page.locator('[data-preview="remote.gltf"]').click();
  await expect(page.locator(".viewport-note")).toContainText(/network/i);
  expect(remoteRequests).toEqual([]);
});

test("untrusted labels remain text in the gallery and exported SVG", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#demoButton").click();
  await expect(page.locator(".model-card")).toHaveCount(8);
  const payload = '<img src=x onerror="window.untrustedLabelExecuted=true">';
  await page.locator("#metricsInput").setInputFiles({
    name: "metadata.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        {
          path: "ours/chair.glb",
          method: payload,
          category: payload,
          prompt: payload,
        },
      ]),
    ),
  });
  await expect(
    page.locator('[data-id="ours/chair.glb"] .card-category'),
  ).toContainText(payload);
  expect(
    await page.evaluate(() => window.untrustedLabelExecuted),
  ).toBeUndefined();
  expect(
    await page.locator('[data-id="ours/chair.glb"] .card-category img').count(),
  ).toBe(0);
  const embedded = await page.evaluate(async (label) => {
    const { editableSheet } = await import("/src/export.js");
    const { DEFAULTS } = await import("/src/core.js");
    const svg = editableSheet(
      [{ path: label, label, data: "data:image/png;base64," }],
      { ...DEFAULTS, caption: label },
    );
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    return {
      scripts: parsed.querySelectorAll("script,img,[onerror]").length,
      errors: parsed.querySelectorAll("parsererror").length,
      title: parsed.querySelector("title").textContent,
    };
  }, payload);
  expect(embedded).toEqual({ scripts: 0, errors: 0, title: payload });
});
