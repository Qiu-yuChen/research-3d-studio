import messages from "./messages.json" with { type: "json" };

const storageKey = "r3d-language";
let language = "en";
try {
  const saved = globalThis.localStorage?.getItem(storageKey);
  if (saved === "en" || saved === "zh") language = saved;
} catch {
  // Storage may be unavailable in private or restricted browser contexts.
}

export const getLanguage = () => language;
export function setLanguage(next) {
  language = next === "zh" ? "zh" : "en";
  try {
    globalThis.localStorage?.setItem(storageKey, language);
  } catch {}
  return language;
}

export function t(key, params = {}) {
  const entry = messages[key];
  if (!entry) throw new Error(`Unknown translation key: ${key}`);
  return entry[language].replace(/\{(\w+)\}/g, (_, name) =>
    String(params[name] ?? `{${name}}`),
  );
}

// Keep a message's identity so status and error text can switch without rerunning work.
export function message(key, params = {}) {
  return { toString: () => t(key, params) };
}
export function localizedError(key, params = {}) {
  const error = new Error(t(key, params));
  Object.defineProperty(error, "message", { get: () => t(key, params) });
  return error;
}
export function messageText(value) {
  if (typeof value === "function") return messageText(value());
  return value instanceof Error ? value.message : String(value ?? "");
}

export function translatePage(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]"))
    el.textContent = t(el.getAttribute("data-i18n"));
  for (const attr of ["title", "placeholder", "aria-label"])
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`))
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  root.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  root.querySelector("#language").value = language;
}
