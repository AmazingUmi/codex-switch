// Set only by the dedicated preview build script; ordinary dev builds keep
// their existing update behavior.
export const IS_CODEX_PREVIEW = import.meta.env.VITE_CODEX_PREVIEW === "true";
