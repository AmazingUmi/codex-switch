import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { migrateBrowserPreferences } from "@/lib/browserStorage";

function storageMethodOwner(method: "setItem" | "key"): Storage {
  // jsdom Storage is a proxy; its methods must be mocked on the prototype.
  // The fallback storage used by other Node versions owns its methods directly.
  return Object.prototype.hasOwnProperty.call(localStorage, method)
    ? localStorage
    : Object.getPrototypeOf(localStorage);
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("browser preference migration", () => {
  it("copies visible legacy preferences once and preserves unrelated keys", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    localStorage.setItem("cc-switch-last-view", "settings");
    localStorage.setItem("cc-switch-last-app", "codex");
    localStorage.setItem("language", "ja");

    migrateBrowserPreferences();
    migrateBrowserPreferences();

    expect(localStorage.getItem("codex-switch-theme")).toBe("dark");
    expect(localStorage.getItem("codex-switch-last-view")).toBe("settings");
    expect(localStorage.getItem("codex-switch-last-app")).toBe("codex");
    expect(localStorage.getItem("language")).toBe("ja");
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      ).some((key) => key?.startsWith("cc-switch-")),
    ).toBe(false);
  });

  it("keeps newer preferences when both namespaces exist", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    localStorage.setItem("codex-switch-theme", "light");
    migrateBrowserPreferences();
    expect(localStorage.getItem("codex-switch-theme")).toBe("light");
    expect(localStorage.getItem("cc-switch-theme")).toBeNull();
  });

  it("retains the source on a failed write and retries after recovery", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    const write = vi
      .spyOn(storageMethodOwner("setItem"), "setItem")
      .mockImplementation(() => {
        throw new Error("Quota exceeded");
      });
    expect(() => migrateBrowserPreferences()).not.toThrow();
    expect(write).toHaveBeenCalledWith("codex-switch-theme", "dark");
    expect(localStorage.getItem("cc-switch-theme")).toBe("dark");
    write.mockRestore();
    migrateBrowserPreferences();
    expect(localStorage.getItem("codex-switch-theme")).toBe("dark");
    expect(localStorage.getItem("cc-switch-theme")).toBeNull();
  });

  it("does not block rendering when storage cannot be enumerated", () => {
    const enumerate = vi
      .spyOn(storageMethodOwner("key"), "key")
      .mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
    localStorage.setItem("cc-switch-theme", "dark");
    expect(() => migrateBrowserPreferences()).not.toThrow();
    expect(enumerate).toHaveBeenCalledWith(0);
    expect(localStorage.getItem("cc-switch-theme")).toBe("dark");
  });
});

describe("pre-render theme migration", () => {
  const html = readFileSync("src/index.html", "utf8");
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const runThemeScript = () => new Function(inlineScript ?? "")();

  it("copies the old theme before painting and leaves a new theme unchanged", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    runThemeScript();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("codex-switch-theme")).toBe("dark");
    expect(localStorage.getItem("cc-switch-theme")).toBeNull();

    localStorage.setItem("cc-switch-theme", "dark");
    localStorage.setItem("codex-switch-theme", "light");
    runThemeScript();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("codex-switch-theme")).toBe("light");
  });

  it("keeps the old theme available if a write fails", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    const write = vi
      .spyOn(storageMethodOwner("setItem"), "setItem")
      .mockImplementation(() => {
        throw new Error("Quota exceeded");
      });
    expect(runThemeScript).not.toThrow();
    expect(write).toHaveBeenCalledWith("codex-switch-theme", "dark");
    expect(localStorage.getItem("cc-switch-theme")).toBe("dark");
  });
});
