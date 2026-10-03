export type CredentialStatus =
  | "valid"
  | "expired"
  | "not_found"
  | "parse_error";

export interface QuotaTier {
  name: string;
  utilization: number; // 0-100
  resetsAt: string | null;
  /** Exact API window length, when provided; names may round custom windows. */
  windowDurationSeconds?: number | null;
  usedValueUsd?: number | null;
  maxValueUsd?: number | null;
  planLabel?: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface SubscriptionQuota {
  tool: string;
  credentialStatus: CredentialStatus;
  credentialMessage: string | null;
  success: boolean;
  tiers: QuotaTier[];
  extraUsage: ExtraUsage | null;
  error: string | null;
  queriedAt: number | null;
  /** Account-scoped projection shared with the native menu bar. */
  refreshState?: {
    status: "ready" | "stale" | "unavailable" | "expired";
    refreshFailed: boolean;
    error: string | null;
    freshUntil: number | null;
    validUntil: number | null;
    generation: number;
    attemptedAt: number | null;
  };
}
