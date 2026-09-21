import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import messages from "../src/messages.json" with { type: "json" };
import {
  getLanguage,
  setLanguage,
  t,
  message,
  localizedError,
} from "../src/i18n.js";
import { parseCSV } from "../src/core.js";

test("English is the default and invalid preferences fall back to English", () => {
  assert.equal(getLanguage(), "en");
  assert.equal(t("heading"), "Your 3D research workspace");
  setLanguage("zh");
  assert.equal(t("heading"), "你的 3D 研究工作台");
  setLanguage("unsupported");
  assert.equal(getLanguage(), "en");
});

test("both languages preserve interpolation fields and every static key exists", () => {
  const fields = (text) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [key, entry] of Object.entries(messages)) {
    assert.ok(entry.en?.trim(), `${key}: missing English`);
    assert.ok(entry.zh?.trim(), `${key}: missing Chinese`);
    assert.deepEqual(fields(entry.en), fields(entry.zh), key);
  }
  const html = fs.readFileSync(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  for (const [, key] of html.matchAll(
    /data-i18n(?:-(?:title|placeholder|aria-label))?="([^"]+)"/g,
  ))
    assert.ok(messages[key], `Missing static translation: ${key}`);
});

test("status and validation errors switch language while user data stays literal", () => {
  const name = "原色 {count} $& <model>.glb";
  const status = message("thumbnail", { name });
  const error = localizedError("missingModel", { path: name });
  assert.equal(String(status), `Thumbnail of ${name}`);
  assert.ok(error.message.includes(name));
  assert.throws(() => parseCSV("x,x\n1,2"), /duplicate column names/);
  setLanguage("zh");
  assert.equal(String(status), `${name} 模型缩略图`);
  assert.equal(error.message, `未找到 ${name}，请重新连接原工作区`);
  assert.throws(() => parseCSV("x,x\n1,2"), /重复列名/);
  setLanguage("en");
});
