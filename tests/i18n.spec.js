import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

async function project(page) {
  const pending = page.waitForEvent("download");
  await page.locator("#saveProject").click();
  const file = await pending;
  return JSON.parse(await fs.readFile(await file.path(), "utf8"));
}

test("English default, live language switch and persistence preserve the current research setup", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#language")).toHaveValue("en");
  await expect(page.locator("h1")).toHaveText("Your 3D research workspace");
  await page.locator("#demoButton").click();
  await expect(page.locator(".model-card")).toHaveCount(8);
  await page.locator("#collectionLayout").selectOption("grid");
  await page.locator("#sort").selectOption("delta");
  await page.locator("#metric").selectOption("clip");
  await page.locator('[data-select="ours/chair.glb"]').check();
  await page.locator('[data-select="base/chair.glb"]').check();
  await page.locator("#compareSelected").click();
  await expect(
    page.locator(".viewport-note").filter({ hasText: "triangles" }),
  ).toHaveCount(2);
  await page.locator("#azimuth").fill("72");
  await page.locator("#azimuth").dispatchEvent("change");
  await page.locator("#editPrompt").evaluate((el) => {
    el.value = "中文 prompt <sample> {count}";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const before = await project(page);
  await page.locator(".canvas-stage canvas").evaluateAll((els) =>
    els.forEach((el) => {
      el.dataset.languageTest = "original";
    }),
  );
  await page.locator("#language").selectOption("zh");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("#exportCurrent")).toHaveText("下载当前视图 PNG ↓");
  await expect(page.locator("#metricNote")).toContainText("同一样本配对");
  await expect(page.locator("#status")).toContainText("工程已保存");
  await expect(page.locator('#passChoices [data-i18n="normal"]')).toHaveText(
    "法线",
  );
  await expect(
    page.locator(".canvas-stage canvas[data-language-test=original]"),
  ).toHaveCount(2);
  const after = await project(page);
  for (const key of [
    "assets",
    "settings",
    "cameras",
    "selected",
    "collection",
    "comparison",
  ])
    expect(after[key]).toEqual(before[key]);
  await page.locator("#language").selectOption("en");
  await expect(page.locator("#status")).toContainText("Project saved");
  await expect(page.locator("#metricNote")).toContainText("paired by sample");
  await expect(page.locator("#editPrompt")).toHaveValue(
    "中文 prompt <sample> {count}",
  );
  await expect(page.locator("#sort")).toHaveValue("delta");
  await page.screenshot({
    path: "test-results/english-comparison.png",
    fullPage: true,
  });
  await page.locator("#helpButton").click();
  await expect(page.locator("#helpDialog")).toContainText(
    "From folders to paper figures",
  );
  await page.locator("#helpDialog button").click();
  await page.locator("#language").selectOption("zh");
  await page.reload();
  await expect(page.locator("#language")).toHaveValue("zh");
  await expect(page.locator("#status")).toContainText("已恢复上次设置");
  await page.locator("#language").selectOption("en");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(errors).toEqual([]);
});

test("errors, file names, accessibility text and compact layouts work in both languages", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("#cameraInput")
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
  await expect(page.locator("#status")).toHaveText("Invalid camera file");
  await page.locator("#language").selectOption("zh");
  await expect(page.locator("#status")).toHaveText("无效的相机文件");
  await page.locator("#language").selectOption("en");
  await expect(page.locator("#status")).toHaveText("Invalid camera file");
  await page
    .locator("#filesInput")
    .setInputFiles({
      name: "原色.glb",
      mimeType: "model/gltf-binary",
      buffer: await fs.readFile("public/demo/ours/chair.glb"),
    });
  await expect(page.locator(".card-name")).toHaveText("原色.glb");
  await expect(page.locator(".thumb")).toHaveAttribute(
    "aria-label",
    "Preview 原色.glb",
  );
  await page.locator("#language").selectOption("zh");
  await expect(page.locator(".thumb")).toHaveAttribute(
    "aria-label",
    "预览 原色.glb",
  );
  await expect(page.locator(".card-name")).toHaveText("原色.glb");
  await page.locator("#language").selectOption("en");
  for (const width of [1100, 850, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#language")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: "test-results/english-mobile.png",
    fullPage: true,
  });
});

test("first visit stays English in a Chinese browser and when preference storage is unavailable", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "r3d-language")
          throw new DOMException("Storage denied", "SecurityError");
        return original.call(this, key, value);
      };
    });
    await page.goto("http://127.0.0.1:5178/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.locator("#language").selectOption("zh");
    await expect(page.locator("h1")).toHaveText("你的 3D 研究工作台");
  } finally {
    await context.close();
  }
});
