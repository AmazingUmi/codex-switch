import type { Settings } from "@/types";

export type RoutingPreference =
  | "enableLocalProxy"
  | "proxyConfirmed"
  | "enableFailoverToggle"
  | "failoverConfirmed";

export function withoutRoutingPreferences(
  settings: Settings,
): Omit<Settings, RoutingPreference> {
  const {
    enableLocalProxy: _local,
    proxyConfirmed: _confirmed,
    enableFailoverToggle: _failover,
    failoverConfirmed: _failoverConfirmed,
    ...directSettings
  } = settings;
  return directSettings;
}
