/** Migrate preferences visible in this WebView's storage to the product namespace. */
export function migrateBrowserPreferences(storage?: Storage): void {
  try {
    const preferences = storage ?? window.localStorage;
    const legacyKeys: string[] = [];
    for (let index = 0; index < preferences.length; index += 1) {
      const key = preferences.key(index);
      if (key?.startsWith("cc-switch-")) legacyKeys.push(key);
    }

    for (const legacyKey of legacyKeys) {
      try {
        const value = preferences.getItem(legacyKey);
        if (value === null) continue;
        const key = legacyKey.replace(/^cc-switch-/, "codex-switch-");
        // A newer preference always wins over a legacy value.
        if (preferences.getItem(key) === null) preferences.setItem(key, value);
        // Keep the source if copying fails; a later startup can retry.
        preferences.removeItem(legacyKey);
      } catch {
        // Unavailable storage must not prevent rendering or other migrations.
      }
    }
  } catch {
    // WebView storage may be unavailable or restricted.
  }
}
