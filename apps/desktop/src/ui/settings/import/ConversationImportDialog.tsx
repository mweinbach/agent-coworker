import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  DownloadIcon,
  FolderInputIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { pickDirectory } from "../../../lib/desktopCommands";
import { cn } from "../../../lib/utils";
import type {
  ConversationImportSource,
  ConversationPreviewItem,
  ConversationSourceCandidate,
  ConversationSourceRequest,
  ConversationWorkspaceMappingInput,
} from "../../../lib/wsProtocol";
import { SettingsEmptyState } from "../SettingsPrimitives";

const SOURCE_OPTIONS: Array<{ source: ConversationImportSource; label: string; hint: string }> = [
  { source: "codex", label: "Codex", hint: "~/.codex/state_5.sqlite and sessions" },
  { source: "claude-code", label: "Claude Code", hint: "~/.claude/projects JSONL" },
  { source: "cowork", label: "Cowork backup", hint: "Choose an alternate .cowork folder" },
];

function sourceLabel(source: ConversationImportSource): string {
  return SOURCE_OPTIONS.find((option) => option.source === source)?.label ?? source;
}

function formatCount(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildSourceRequests(input: {
  selectedSources: ReadonlySet<ConversationImportSource>;
  coworkPath: string | null;
}): ConversationSourceRequest[] | undefined {
  if (input.coworkPath && input.selectedSources.has("cowork")) {
    const requests: ConversationSourceRequest[] = [];
    for (const source of input.selectedSources) {
      requests.push(source === "cowork" ? { source, path: input.coworkPath } : { source });
    }
    return requests;
  }
  return undefined;
}

function sourceSelectionParams(input: {
  selectedSources: ReadonlySet<ConversationImportSource>;
  coworkPath: string | null;
}): {
  sources?: ConversationSourceRequest[];
  includeCodex?: boolean;
  includeClaudeCode?: boolean;
  includeCowork?: boolean;
} {
  const sources = buildSourceRequests(input);
  if (sources) return { sources };
  return {
    includeCodex: input.selectedSources.has("codex"),
    includeClaudeCode: input.selectedSources.has("claude-code"),
    includeCowork: input.selectedSources.has("cowork"),
  };
}

function isConversationBlockedByMapping(
  conversation: ConversationPreviewItem,
  mappings: Record<string, ConversationWorkspaceMappingInput>,
): boolean {
  return conversation.mapping.status === "missing" && mappings[conversation.fingerprint] == null;
}

export function ConversationImportDialog({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const workspaces = useAppStore((state) => state.workspaces);
  const listSources = useAppStore((state) => state.listConversationImportSources);
  const previewImports = useAppStore((state) => state.previewConversationImports);
  const importConversations = useAppStore((state) => state.importConversations);
  const selectThread = useAppStore((state) => state.selectThread);
  const [open, setOpen] = useState(defaultOpen);
  const [selectedSources, setSelectedSources] = useState<Set<ConversationImportSource>>(
    () => new Set(["codex", "claude-code"]),
  );
  const [coworkPath, setCoworkPath] = useState<string | null>(null);
  const [sources, setSources] = useState<ConversationSourceCandidate[]>([]);
  const [conversations, setConversations] = useState<ConversationPreviewItem[]>([]);
  const [selectedFingerprints, setSelectedFingerprints] = useState<Set<string>>(() => new Set());
  const [mappings, setMappings] = useState<Record<string, ConversationWorkspaceMappingInput>>({});
  const [busy, setBusy] = useState<"scan" | "preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof importConversations>> | null>(
    null,
  );

  const params = useMemo(
    () => sourceSelectionParams({ selectedSources, coworkPath }),
    [coworkPath, selectedSources],
  );

  const selectedConversations = useMemo(
    () =>
      conversations.filter((conversation) => selectedFingerprints.has(conversation.fingerprint)),
    [conversations, selectedFingerprints],
  );
  const selectedBlocked = selectedConversations.some((conversation) =>
    isConversationBlockedByMapping(conversation, mappings),
  );
  const alreadyImportedCount = conversations.filter(
    (conversation) => conversation.alreadyImportedThreadId != null,
  ).length;

  const scan = useCallback(async () => {
    if (selectedSources.size === 0) return;
    setBusy("scan");
    setError(null);
    setResult(null);
    try {
      const sourceResult = await listSources(params);
      setSources(sourceResult.sources);
      setBusy("preview");
      const preview = await previewImports({ ...params, limit: 250 });
      setConversations(preview.conversations);
      setSelectedFingerprints(
        new Set(
          preview.conversations
            .filter((conversation) => conversation.alreadyImportedThreadId == null)
            .map((conversation) => conversation.fingerprint),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [listSources, params, previewImports, selectedSources.size]);

  useEffect(() => {
    if (!open) return;
    void scan();
  }, [open, scan]);

  const toggleSource = (source: ConversationImportSource, checked: boolean) => {
    setSelectedSources((current) => {
      const next = new Set(current);
      if (checked) next.add(source);
      else next.delete(source);
      return next;
    });
  };

  const chooseCoworkPath = async () => {
    const picked = await pickDirectory({ title: "Choose an alternate .cowork folder or backup" });
    if (picked) {
      setCoworkPath(picked);
      setSelectedSources((current) => new Set([...current, "cowork"]));
    }
  };

  const toggleConversation = (fingerprint: string, checked: boolean) => {
    setSelectedFingerprints((current) => {
      const next = new Set(current);
      if (checked) next.add(fingerprint);
      else next.delete(fingerprint);
      return next;
    });
  };

  const setFallbackMapping = (fingerprint: string, workspaceId: string) => {
    setMappings((current) => ({
      ...current,
      [fingerprint]: { kind: "fallback", workspaceId },
    }));
  };

  const doImport = async () => {
    if (selectedConversations.length === 0 || selectedBlocked) return;
    setBusy("import");
    setError(null);
    try {
      const nextResult = await importConversations({
        ...params,
        selected: selectedConversations.map((conversation) => ({
          source: conversation.source,
          fingerprint: conversation.fingerprint,
        })),
        mappings,
        mode: "skip-existing",
      });
      setResult(nextResult);
      if (nextResult.imported[0]) {
        await selectThread(nextResult.imported[0].threadId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" type="button" onClick={() => setOpen(true)}>
        <DownloadIcon data-icon="inline-start" />
        Import conversations
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
          <DialogHeader className="border-b border-border/60 px-6 pb-4 pt-6">
            <DialogTitle>Import conversations</DialogTitle>
            <DialogDescription>
              Bring Codex, Claude Code, or Cowork backup chats into Cowork as normal threads. Future
              turns use sanitized context, not provider continuation state.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
            <div className="flex flex-col gap-2">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Sources
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {SOURCE_OPTIONS.map((option) => {
                  const checked = selectedSources.has(option.source);
                  return (
                    <label
                      key={option.source}
                      htmlFor={`conversation-import-source-${option.source}`}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 p-3 transition-colors hover:bg-muted/40",
                        checked && "bg-primary/10",
                      )}
                    >
                      <Checkbox
                        id={`conversation-import-source-${option.source}`}
                        checked={checked}
                        onCheckedChange={(value) => toggleSource(option.source, value === true)}
                        aria-label={option.label}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => void chooseCoworkPath()}
                >
                  <FolderInputIcon data-icon="inline-start" />
                  {coworkPath ? "Change Cowork path" : "Choose Cowork backup…"}
                </Button>
                {coworkPath ? (
                  <span className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                    {coworkPath}
                  </span>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={busy !== null || selectedSources.size === 0}
                  onClick={() => void scan()}
                >
                  {busy === "scan" || busy === "preview" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCcwIcon data-icon="inline-start" />
                  )}
                  Refresh
                </Button>
              </div>
            </div>

            {sources.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {sources.map((candidate) => (
                  <Badge key={candidate.id} variant={candidate.available ? "secondary" : "outline"}>
                    {sourceLabel(candidate.source)} ·{" "}
                    {candidate.available ? "available" : "missing"}
                    {candidate.conversationCount != null ? ` · ${candidate.conversationCount}` : ""}
                  </Badge>
                ))}
              </div>
            ) : null}

            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            {busy ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Spinner />
                {busy === "import" ? "Importing conversations…" : "Scanning conversations…"}
              </div>
            ) : conversations.length === 0 ? (
              <SettingsEmptyState
                icon={<DatabaseIcon />}
                title="No conversations found"
                description="Choose sources and refresh to preview importable chats."
              />
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    {formatCount(conversations.length, "conversation")}
                    {alreadyImportedCount > 0 ? ` · ${alreadyImportedCount} already imported` : ""}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatCount(selectedConversations.length, "selected")}
                  </div>
                </div>
                <div className="flex flex-col divide-y divide-border/40">
                  {conversations.map((conversation) => {
                    const checked = selectedFingerprints.has(conversation.fingerprint);
                    const needsMapping = conversation.mapping.status === "missing";
                    const blocked =
                      checked && isConversationBlockedByMapping(conversation, mappings);
                    const mapping = mappings[conversation.fingerprint];
                    return (
                      <div
                        key={`${conversation.source}:${conversation.fingerprint}`}
                        className={cn("py-3", blocked && "bg-warning/10")}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={checked}
                            disabled={conversation.alreadyImportedThreadId != null}
                            onCheckedChange={(value) =>
                              toggleConversation(conversation.fingerprint, value === true)
                            }
                            aria-label={`Import ${conversation.title}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {conversation.title}
                              </span>
                              <Badge variant="outline">{sourceLabel(conversation.source)}</Badge>
                              {conversation.alreadyImportedThreadId ? (
                                <Badge variant="secondary">Imported</Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                              <span>{formatCount(conversation.messageCount, "message")}</span>
                              {conversation.toolCount > 0 ? (
                                <span>{formatCount(conversation.toolCount, "tool")}</span>
                              ) : null}
                              {conversation.originalModel ? (
                                <span>{conversation.originalModel}</span>
                              ) : null}
                              <span>{formatDate(conversation.updatedAt)}</span>
                            </div>
                            {conversation.cwd ? (
                              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                                {conversation.cwd}
                              </div>
                            ) : null}
                            {needsMapping ? (
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <span className="text-xs text-warning-foreground">
                                  Needs workspace mapping
                                </span>
                                <Select
                                  value={mapping?.kind === "fallback" ? mapping.workspaceId : ""}
                                  onValueChange={(workspaceId) =>
                                    setFallbackMapping(conversation.fingerprint, workspaceId)
                                  }
                                >
                                  <SelectTrigger className="h-8 w-56 text-xs">
                                    <SelectValue placeholder="Import into…" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {workspaces.map((workspace) => (
                                      <SelectItem key={workspace.id} value={workspace.id}>
                                        {workspace.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}
                            {conversation.warnings.length > 0 ? (
                              <div className="mt-2 flex flex-col gap-1 text-[11px] text-muted-foreground">
                                {conversation.warnings.slice(0, 2).map((warning) => (
                                  <div key={`${conversation.fingerprint}:${warning.code}`}>
                                    {warning.message}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {result ? (
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground">
                <CheckCircle2Icon className="size-4 text-primary" />
                <span>
                  Imported {result.imported.length}, skipped {result.skipped.length}, failed{" "}
                  {result.failed.length}.
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-4">
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              type="button"
              disabled={busy !== null || selectedConversations.length === 0 || selectedBlocked}
              onClick={() => void doImport()}
            >
              {busy === "import" ? <Spinner data-icon="inline-start" /> : null}
              Import selected
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
