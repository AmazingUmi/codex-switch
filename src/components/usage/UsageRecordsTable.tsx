import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Tag,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useSetUsageAttribution,
  useUndoUsageAttribution,
  useUsageAttributionChoices,
  useUsageRecords,
  usageKeys,
} from "@/lib/query/usage";
import { usageApi } from "@/lib/api/usage";
import { resolveUsageRange } from "@/lib/usageRange";
import type {
  UsageAttributionSelector,
  UsageRecordFilters,
  UsageRecordRow,
  UsageRecordsView,
  UsageRangeSelection,
} from "@/types/usage";
import {
  fmtInt,
  fmtUsd,
  getLocaleFromLanguage,
  getUsageTimeZone,
} from "./format";
import { UsageDateRangePicker } from "./UsageDateRangePicker";
import {
  UNASSIGNED_SOURCE,
  sourceIdentity,
  sourceFilters,
  flatSourceChoices,
  sourceOptionLabel,
  rowSourceIdentities,
  usageRowSource,
} from "@/lib/usageSource";

interface Props {
  range: UsageRangeSelection;
  rangeLabel: string;
  appType?: string;
  sourceId?: string;
  onSourceChange?: (sourceId: string) => void;
  model?: string;
  refreshIntervalMs: number;
  onRangeChange?: (range: UsageRangeSelection) => void;
}

const ALL_SOURCES_VALUE = "__all_sources__";

type FilterOption = { value: string; label: string };

function UsageFilterSelect({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  fullWidth = false,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: FilterOption[];
  placeholder?: string;
  disabled?: boolean;
  fullWidth?: boolean;
}) {
  const selectedLabel =
    options.find((option) => option.value === value)?.label || placeholder;
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        aria-label={label}
        title={selectedLabel}
        className={`h-9 min-w-0 max-w-full gap-2 px-4 text-xs font-medium [&>span]:min-w-0 [&>span]:truncate [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 ${fullWidth ? "w-full" : "w-auto max-w-[min(18rem,100%)]"}`}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-w-[min(24rem,calc(100vw-2rem))]">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            title={option.label}
            className="[&>span]:min-w-0 [&>span]:truncate"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** All-page selectors use query bounds, never the visible page's record IDs. */
export function usageRowSelector(
  row: UsageRecordRow,
  filters: UsageRecordFilters,
): UsageAttributionSelector {
  const { appType: _appType, ...scope } = filters;
  if (row.requestId) return { requestIds: [row.requestId] };
  if (row.sessionId) return { ...scope, sessionId: row.sessionId };
  const identities = rowSourceIdentities(row);
  const identity = identities.size === 1 ? [...identities][0] : undefined;
  const identityFilters = identity
    ? sourceFilters(identity)
    : { accountId: scope.accountId, providerId: scope.providerId };
  return {
    ...scope,
    startDate: Math.max(
      scope.startDate ?? -Infinity,
      row.bucketStartAt ?? row.startAt,
    ),
    endDate: Math.min(
      scope.endDate ?? Infinity,
      (row.bucketEndAt ?? row.endAt + 1) - 1,
    ),
    ...identityFilters,
    attribution: row.method === "untagged" ? "untagged" : scope.attribution,
  };
}

export function UsageRecordsTable({
  range,
  rangeLabel,
  sourceId: controlledSourceId,
  onSourceChange,
  model,
  refreshIntervalMs,
  onRangeChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<UsageRecordsView>("session");
  const [timezone, setTimezone] = useState<"local" | "UTC">("local");
  const [attribution, setAttribution] =
    useState<UsageRecordFilters["attribution"]>("all");
  const [localSourceId, setLocalSourceId] = useState("");
  const sourceId = controlledSourceId ?? localSourceId;
  const changeSource = (next: string) => {
    if (controlledSourceId === undefined) setLocalSourceId(next);
    onSourceChange?.(next);
  };
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tagScope, setTagScope] = useState<UsageAttributionSelector | null>(
    null,
  );
  const [lastAction, setLastAction] = useState<number | null>(null);
  const choices = useUsageAttributionChoices();
  const undo = useUndoUsageAttribution();
  const sourceChoices = useMemo(
    () => flatSourceChoices(choices.data ?? []),
    [choices.data],
  );
  const sourceLabel = (row: UsageRecordRow) => {
    const source = usageRowSource(row, sourceChoices);
    return source.multiple
      ? t("usage.records.multiple", "Multiple")
      : source.name || t("usage.records.untagged", "Unassigned");
  };
  const locale = getLocaleFromLanguage(
    i18n.resolvedLanguage || i18n.language || "en",
  );
  const filters = useMemo(
    () => ({
      appType: "codex",
      model,
      attribution,
      ...sourceFilters(sourceId),
    }),
    [model, attribution, sourceId],
  );
  const result = useUsageRecords({
    filters,
    range,
    view,
    page,
    timezone,
    options: {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  });
  const pages = Math.max(1, Math.ceil((result.data?.total ?? 0) / 20));
  useEffect(() => {
    setPage(0);
    setExpanded(null);
  }, [filters, range, view, timezone]);
  useEffect(() => {
    if (page >= pages) setPage(pages - 1);
  }, [page, pages]);

  const effective = () => ({ ...filters, ...resolveUsageRange(range) });
  const selectRange = () => {
    const { appType: _appType, ...selector } = effective();
    setTagScope(selector);
  };
  const dateLabel = (timestamp: number) =>
    new Intl.DateTimeFormat(locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone === "UTC" ? { timeZone: "UTC" } : {}),
    }).format(timestamp * 1000);
  const costLabel = (row: UsageRecordRow) =>
    row.unpricedCount >= row.recordCount
      ? "—"
      : `${fmtUsd(row.totalCostUsd, 4)}${row.unpricedCount > 0 ? " *" : ""}`;
  const methodLabel = (row: UsageRecordRow) =>
    t(`usage.records.method.${row.method}`, row.method);
  const heads = [
    "session",
    "source",
    "models",
    "count",
    "input",
    "output",
    "cache",
    "cost",
  ];
  const renderCells = (row: UsageRecordRow, detail = false) => (
    <>
      <TableCell className="min-w-[150px] text-xs">
        <div className="flex items-center gap-1">
          {!detail && view !== "details" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              aria-label={t("usage.records.expand", "Expand records")}
              aria-expanded={expanded === row.id}
              onClick={() => setExpanded(expanded === row.id ? null : row.id)}
            >
              <ChevronDown
                className={`h-3.5 w-3.5 ${expanded === row.id ? "rotate-180" : ""}`}
              />
            </Button>
          )}
          <div>
            <div
              className="font-mono"
              title={row.sessionId || row.requestId || row.id}
            >
              {row.sessionId
                ? row.sessionId.slice(0, 8)
                : row.requestId
                  ? row.requestId.slice(-10)
                  : dateLabel(row.startAt)}
            </div>
            <div className="whitespace-nowrap text-muted-foreground">
              {dateLabel(row.startAt)}
              {row.endAt !== row.startAt ? ` – ${dateLabel(row.endAt)}` : ""}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="text-xs">
        {sourceLabel(row)}
        <div
          className="text-[10px] text-muted-foreground"
          title={
            row.method === "auto"
              ? t(
                  "usage.records.autoHelp",
                  "Based on the observed active configuration; upstream billing is not verified.",
                )
              : undefined
          }
        >
          {methodLabel(row)}
        </div>
      </TableCell>
      <TableCell
        className="max-w-[150px] truncate font-mono text-xs"
        title={row.models.join(", ")}
      >
        {row.models.length > 1
          ? t("usage.records.multiple", "Multiple")
          : row.models[0] || "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtInt(row.recordCount, locale)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtInt(row.inputTokens, locale)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {fmtInt(row.outputTokens, locale)}
      </TableCell>
      <TableCell
        className="text-right tabular-nums"
        title={`${t("usage.cacheCreationTokens")}: ${fmtInt(row.cacheCreationTokens, locale)}`}
      >
        {fmtInt(row.cacheReadTokens, locale)}
      </TableCell>
      <TableCell
        className="text-right tabular-nums"
        title={
          row.unpricedCount > 0
            ? t(
                "usage.records.unpriced",
                "Some records have no price; the estimate covers priced records only.",
              )
            : undefined
        }
      >
        {costLabel(row)}
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("usage.records.tagRow", "Assign this record or group")}
          onClick={() => setTagScope(usageRowSelector(row, effective()))}
        >
          <Tag className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </>
  );

  return (
    <div className="space-y-2">
      {(result.data?.legacyRollupCount ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {t(
            "usage.records.legacySummary",
            "Some historical usage has summary data only. Rebuild usage to rescan available session logs for details.",
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <UsageFilterSelect
          label={t("usage.records.view", "View")}
          value={view}
          onValueChange={(value) => setView(value as UsageRecordsView)}
          options={(["session", "hour", "day", "details"] as const).map(
            (value) => ({
              value,
              label: t(`usage.records.views.${value}`, value),
            }),
          )}
        />
        <UsageFilterSelect
          label={t("usage.records.attribution", "Attribution")}
          value={attribution || "all"}
          onValueChange={(value) =>
            setAttribution(value as UsageRecordFilters["attribution"])
          }
          options={["all", "untagged", "auto", "manual"].map((value) => ({
            value,
            label: t(`usage.records.method.${value}`, value),
          }))}
        />
        <UsageFilterSelect
          label={t("usage.records.source", "Source")}
          value={sourceId || ALL_SOURCES_VALUE}
          onValueChange={(value) =>
            changeSource(value === ALL_SOURCES_VALUE ? "" : value)
          }
          options={[
            {
              value: ALL_SOURCES_VALUE,
              label: t("usage.records.allSources", "All sources"),
            },
            {
              value: UNASSIGNED_SOURCE,
              label: t("usage.records.untagged", "Unassigned"),
            },
            ...sourceChoices.map((choice) => ({
              value: sourceIdentity(choice.accountId, choice.providerId),
              label: sourceOptionLabel(
                choice,
                sourceChoices,
                t("usage.records.accountType", "Account"),
                t("usage.records.apiType", "API"),
              ),
            })),
          ]}
        />
        {onRangeChange && (
          <UsageDateRangePicker
            selection={range}
            triggerLabel={rangeLabel}
            onApply={onRangeChange}
          />
        )}
        <UsageFilterSelect
          label={t("usage.records.timezone", "Time zone")}
          value={timezone}
          onValueChange={(value) => setTimezone(value as "local" | "UTC")}
          options={[
            { value: "local", label: getUsageTimeZone() },
            { value: "UTC", label: "UTC" },
          ]}
        />
        <div className="ml-auto flex gap-1">
          {lastAction !== null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={undo.isPending}
              onClick={async () => {
                try {
                  await undo.mutateAsync(lastAction);
                  setLastAction(null);
                  toast.success(t("usage.records.undone", "Assignment undone"));
                } catch (error) {
                  toast.error(String(error));
                }
              }}
            >
              <Undo2 className="mr-1 h-3.5 w-3.5" />
              {t("usage.records.undo", "Undo")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!result.data?.total}
            onClick={selectRange}
          >
            <Tag className="mr-1 h-3.5 w-3.5" />
            {t("usage.records.assignFiltered", "Assign filtered records")}
          </Button>
        </div>
      </div>
      {result.isError ? (
        <div role="alert" className="rounded-lg border p-4 text-sm">
          {String(result.error)}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card/40">
          <Table>
            <TableHeader>
              <TableRow>
                {heads.map((head) => (
                  <TableHead key={head} className="whitespace-nowrap">
                    {t(
                      `usage.records.${head}`,
                      head === "source" ? "Source" : head,
                    )}
                  </TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.isLoading ? (
                <TableRow>
                  <TableCell colSpan={9}>
                    {t("common.loading", "Loading…")}
                  </TableCell>
                </TableRow>
              ) : !result.data?.data.length ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-muted-foreground"
                  >
                    {t("usage.noData")}
                  </TableCell>
                </TableRow>
              ) : (
                result.data.data.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow>{renderCells(row)}</TableRow>
                    {expanded === row.id && view !== "details" && (
                      <TableRow>
                        <TableCell colSpan={9} className="bg-muted/20 p-3">
                          <ExpandedRecords
                            row={row}
                            filters={effective()}
                            timezone={timezone}
                            renderCells={renderCells}
                            sourceLabel={sourceLabel}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t("usage.records.groups", {
            defaultValue: "{{count}} rows",
            count: result.data?.total ?? 0,
          })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={t("usage.records.previous", "Previous page")}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>
            {page + 1} / {pages}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={t("usage.records.next", "Next page")}
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {tagScope && (
        <AttributionDialog
          selector={tagScope}
          onClose={() => setTagScope(null)}
          onApplied={(actionId) => {
            setLastAction(actionId);
            setTagScope(null);
          }}
        />
      )}
    </div>
  );
}

function ExpandedRecords({
  row,
  filters,
  timezone,
  renderCells,
  sourceLabel,
}: {
  row: UsageRecordRow;
  filters: UsageRecordFilters;
  timezone: "local" | "UTC";
  renderCells: (row: UsageRecordRow, detail?: boolean) => React.ReactNode;
  sourceLabel: (row: UsageRecordRow) => string;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const scope = usageRowSelector(row, filters);
  const details = useUsageRecords({
    filters: scope,
    view: "details",
    page,
    timezone,
    options: { refetchInterval: false },
  });
  const pages = Math.max(1, Math.ceil((details.data?.total ?? 0) / 20));
  return (
    <div className="space-y-2">
      {!!row.breakdown?.length && (
        <div className="flex flex-wrap gap-2">
          {row.breakdown.map((part, i) => (
            <span
              key={i}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              {sourceLabel(part)} · {part.models.join(", ")} ·{" "}
              {part.recordCount} {t("usage.records.count", "Usage records")}
              <div className="mt-1 text-muted-foreground">
                {t("usage.records.input", "Input")}: {fmtInt(part.inputTokens)}{" "}
                · {t("usage.records.output", "Output")}:{" "}
                {fmtInt(part.outputTokens)} ·{" "}
                {t("usage.records.cache", "Cache read")}:{" "}
                {fmtInt(part.cacheReadTokens)} ·{" "}
                {t("usage.cacheCreationTokens", "Cache write")}:{" "}
                {fmtInt(part.cacheCreationTokens)} ·{" "}
                {part.unpricedCount >= part.recordCount
                  ? "—"
                  : `${fmtUsd(part.totalCostUsd, 4)}${part.unpricedCount > 0 ? " *" : ""}`}
              </div>
            </span>
          ))}
        </div>
      )}
      <Table>
        <TableBody>
          {details.isLoading ? (
            <TableRow>
              <TableCell colSpan={9}>
                {t("common.loading", "Loading…")}
              </TableCell>
            </TableRow>
          ) : details.isError ? (
            <TableRow>
              <TableCell colSpan={9} role="alert">
                {String(details.error)}
              </TableCell>
            </TableRow>
          ) : (
            details.data?.data.map((record) => (
              <TableRow key={record.id}>{renderCells(record, true)}</TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {pages > 1 && (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {t("usage.records.previous", "Previous page")}
          </Button>
          <span className="self-center text-xs">
            {page + 1} / {pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            {t("usage.records.next", "Next page")}
          </Button>
        </div>
      )}
    </div>
  );
}

function AttributionDialog({
  selector,
  onClose,
  onApplied,
}: {
  selector: UsageAttributionSelector;
  onClose: () => void;
  onApplied: (actionId: number) => void;
}) {
  const { t } = useTranslation();
  const choices = useUsageAttributionChoices();
  const mutation = useSetUsageAttribution();
  const sourceChoices = flatSourceChoices(choices.data ?? []);
  const [choiceId, setChoiceId] = useState("");
  const [onlyUntagged, setOnlyUntagged] = useState(true);
  const preview = useQuery({
    queryKey: [...usageKeys.all, "attribution-preview", selector, onlyUntagged],
    queryFn: () => usageApi.previewUsageAttribution(selector, onlyUntagged),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("usage.records.assign", "Assign usage")}</DialogTitle>
          <DialogDescription>
            {t(
              "usage.records.assignHelp",
              "Choose a source for the selected usage records.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5">
          <label className="block space-y-2 text-sm">
            <span>{t("usage.records.source", "Source")}</span>
            <UsageFilterSelect
              label={t("usage.records.source", "Source")}
              value={choiceId}
              onValueChange={setChoiceId}
              disabled={choices.isLoading || mutation.isPending}
              placeholder={t("usage.records.choose", "Choose…")}
              fullWidth
              options={sourceChoices.map((choice) => ({
                value: choice.id,
                label: sourceOptionLabel(
                  choice,
                  sourceChoices,
                  t("usage.records.accountType", "Account"),
                  t("usage.records.apiType", "API"),
                ),
              }))}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!onlyUntagged}
              disabled={mutation.isPending}
              onCheckedChange={(checked) => setOnlyUntagged(!checked)}
            />
            {t(
              "usage.records.replaceExisting",
              "Replace existing labels in this selection",
            )}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "usage.records.replaceExistingHelp",
              "Only unassigned records are labeled by default. Replacing labels applies only to the records in this selection, within its filters and time range.",
            )}
          </p>
          <p className="text-sm" aria-live="polite">
            {preview.isFetching
              ? t("common.loading", "Loading…")
              : preview.isError
                ? String(preview.error)
                : t("usage.records.affected", {
                    defaultValue: "Currently {{count}} matching usage records",
                    count: preview.data ?? 0,
                  })}
          </p>
          {(choices.isError || mutation.isError) && (
            <p role="alert" className="text-sm text-destructive">
              {String(choices.error || mutation.error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              !choiceId ||
              !preview.data ||
              preview.isFetching ||
              preview.isError ||
              mutation.isPending
            }
            onClick={async () => {
              try {
                const result = await mutation.mutateAsync({
                  selector,
                  choiceId,
                  onlyUntagged,
                });
                toast.success(
                  t("usage.records.assigned", {
                    defaultValue: "Assigned {{count}} usage records",
                    count: result.count,
                  }),
                );
                onApplied(result.actionId);
              } catch {
                /* Mutation error stays visible for retry. */
              }
            }}
          >
            {t("usage.records.apply", "Assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
