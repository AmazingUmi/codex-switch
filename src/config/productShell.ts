import type { AppId } from "@/lib/api/types";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";

// Product navigation is separate from the shared backend capability registry.
// Existing records for other apps remain valid and are never migrated away.
export const PRODUCT_APP_IDS: AppId[] = ["codex"];
export const PRODUCT_VIEW_IDS = ["providers", "settings"] as const;
export type ProductView = (typeof PRODUCT_VIEW_IDS)[number];

export function isProductApp(app: unknown): app is "codex" {
  return app === "codex";
}

export function normalizeProductApp(_app: unknown): AppId {
  return "codex";
}

export function isProductView(view: unknown): view is ProductView {
  return PRODUCT_VIEW_IDS.some((allowed) => allowed === view);
}

export function normalizeProductView(view: unknown): ProductView {
  return isProductView(view) ? view : "providers";
}

export function isProductImportAllowed(
  request: Pick<DeepLinkImportRequest, "app" | "resource">,
): boolean {
  return (
    isProductApp(request.app) &&
    (!request.resource || request.resource === "provider")
  );
}
