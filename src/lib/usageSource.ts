import type { UsageAttributionChoice, UsageRecordRow } from "@/types/usage";

export const UNASSIGNED_SOURCE = "__unassigned__";
export const sourceIdentity = (
  accountId?: string | null,
  providerId?: string | null,
) => {
  if (
    accountId &&
    accountId !== UNASSIGNED_SOURCE &&
    !accountId.startsWith("api:")
  )
    return `account:${accountId}`;
  if (providerId && providerId !== UNASSIGNED_SOURCE)
    return `provider:${providerId}`;
  if (accountId?.startsWith("api:")) return `provider:${accountId.slice(4)}`;
  return UNASSIGNED_SOURCE;
};

export function usageSourceName(
  source: Pick<
    UsageAttributionChoice,
    "accountId" | "accountName" | "providerName"
  >,
): string | null {
  const knownName = (name?: string | null) => {
    const trimmed = name?.trim();
    return trimmed && trimmed !== "Unassigned" ? trimmed : null;
  };
  return source.accountId?.startsWith("api:")
    ? knownName(source.providerName)
    : knownName(source.accountName) || knownName(source.providerName);
}

export function flatSourceChoices(choices: UsageAttributionChoice[]) {
  const unique = new Map<string, UsageAttributionChoice>();
  for (const choice of choices) {
    const identity = sourceIdentity(choice.accountId, choice.providerId);
    if (identity !== UNASSIGNED_SOURCE && !unique.has(identity))
      unique.set(identity, choice);
  }
  return [...unique.values()];
}

export function sourceOptionLabel(
  choice: UsageAttributionChoice,
  choices: UsageAttributionChoice[],
  accountType: string,
  apiType: string,
) {
  const name = usageSourceName(choice) || choice.label;
  const peers = choices.filter(
    (other) => (usageSourceName(other) || other.label) === name,
  );
  if (peers.length < 2) return name;
  const api = sourceIdentity(choice.accountId, choice.providerId).startsWith(
    "provider:",
  );
  const sameType = peers.filter(
    (other) =>
      sourceIdentity(other.accountId, other.providerId).startsWith(
        "provider:",
      ) === api,
  );
  return `${name} (${api ? apiType : accountType}${sameType.length > 1 ? ` · ${(choice.accountId || choice.providerId || choice.id).slice(-6)}` : ""})`;
}

export function rowSourceIdentities(row: UsageRecordRow): Set<string> {
  const parts = row.breakdown?.length ? row.breakdown : [row];
  const identities = new Set<string>();
  for (const part of parts) {
    const accountIds = part.accountIds.length
      ? part.accountIds
      : [UNASSIGNED_SOURCE];
    const providerIds = part.providerIds.length
      ? part.providerIds
      : [UNASSIGNED_SOURCE];
    for (const accountId of accountIds)
      for (const providerId of providerIds)
        identities.add(sourceIdentity(accountId, providerId));
  }
  return identities;
}

export function usageRowSource(
  row: UsageRecordRow,
  choices: UsageAttributionChoice[],
): { name: string | null; multiple: boolean } {
  const parts = row.breakdown?.length ? row.breakdown : [row];
  const identities = rowSourceIdentities(row);
  if (identities.size > 1) return { name: null, multiple: true };
  const part = parts[0];
  const current = choices.find(
    (choice) =>
      sourceIdentity(choice.accountId, choice.providerId) ===
      sourceIdentity(part.accountIds[0], part.providerIds[0]),
  );
  return {
    multiple: false,
    name: current
      ? usageSourceName(current)
      : usageSourceName({
          accountId: part.accountIds[0],
          accountName: part.accountName || part.accountNames[0],
          providerName: part.providerName || part.providerNames[0],
        }),
  };
}

export function sourceFilters(sourceId: string): {
  accountId?: string;
  providerId?: string;
} {
  if (sourceId.startsWith("account:"))
    return { accountId: sourceId.slice(8), providerId: undefined };
  if (sourceId.startsWith("provider:"))
    return { accountId: undefined, providerId: sourceId.slice(9) };
  if (sourceId === UNASSIGNED_SOURCE)
    return { accountId: UNASSIGNED_SOURCE, providerId: UNASSIGNED_SOURCE };
  return { accountId: undefined, providerId: undefined };
}
