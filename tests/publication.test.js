import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedSource,
  contentFindings,
} from "../scripts/check-publication.mjs";

test("publication checks reject private content and allow loopback defaults", () => {
  const cases = [
    ["private-ip", [10, 20, 30, 40].join(".")],
    ["private-ip", [172, 16, 0, 1].join(".")],
    ["private-ip", [192, 168, 1, 2].join(".")],
    ["personal-absolute-path", ["", "Users", "example", "data"].join("/")],
    ["personal-absolute-path", ["C:", "Users", "example"].join("\\")],
    ["github-token", "ghp_" + "a".repeat(30)],
    ["api-token", "sk-" + "a".repeat(30)],
    ["private-key", ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")],
    ["credential-assignment", ["password", " = ", '"example-secret"'].join("")],
    [
      "url-credentials",
      ["https://", "example", ":", "example", "@example.com"].join(""),
    ],
  ];
  for (const [rule, text] of cases)
    assert.ok(contentFindings(Buffer.from(text)).includes(rule), rule);
  assert.deepEqual(
    contentFindings(Buffer.from("http://127.0.0.1:5178 https://example.com")),
    [],
  );
});

test("publication allowlist excludes local configuration, datasets and exports", () => {
  for (const file of [
    ".env",
    ".npmrc",
    "id_ed25519",
    "data/model.glb",
    "exports/project.r3d.zip",
    "docs/private.txt",
    "../README.md",
  ])
    assert.equal(allowedSource(file), false, file);
  for (const file of [
    "README.zh-CN.md",
    "src/main.js",
    "docs/SECURITY_REVIEW.md",
    "public/demo/base/chair.glb",
    "tests/fixtures/triangle.obj",
  ])
    assert.equal(allowedSource(file), true, file);
});
