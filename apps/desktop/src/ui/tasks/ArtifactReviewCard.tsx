import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  EyeIcon,
  FileClockIcon,
  FileIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ArtifactDiff, ArtifactPreview } from "../../../../../src/server/artifacts/types";
import type {
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactVersion,
  TaskStatus,
} from "../../../../../src/shared/tasks";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";

type ArtifactReviewCardProps = {
  taskId: string;
  taskRevision: number;
  taskStatus: TaskStatus;
  artifact: TaskArtifact;
  onOpenFile: (path: string) => void;
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function versionLabel(version: TaskArtifactVersion): string {
  return `Version ${version.version}`;
}

function versionBefore(
  versions: TaskArtifactVersion[],
  selected: TaskArtifactVersion,
): TaskArtifactVersion | null {
  const parent = selected.parentVersionId
    ? versions.find((version) => version.id === selected.parentVersionId)
    : null;
  if (parent) return parent;
  return (
    [...versions]
      .filter((version) => version.version < selected.version)
      .sort((left, right) => right.version - left.version)[0] ?? null
  );
}

function PreviewContent({ preview }: { preview: ArtifactPreview }) {
  if (preview.kind === "text") {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
        {preview.text}
      </pre>
    );
  }
  if (preview.kind === "image") {
    return (
      <img
        alt={preview.filename}
        className="mx-auto max-h-[32rem] max-w-full object-contain"
        src={preview.dataUrl}
      />
    );
  }
  if (preview.kind === "pdf") {
    return (
      <iframe
        className="h-[32rem] w-full rounded-md border border-border"
        src={preview.dataUrl}
        title={`Preview of ${preview.filename}`}
      />
    );
  }
  if (preview.kind === "docx") {
    return (
      <div className="flex flex-col gap-3 text-sm leading-6">
        {preview.document.paragraphs.slice(0, 100).map((paragraph) => (
          <p key={`${paragraph.index}:${paragraph.text}`}>{paragraph.text}</p>
        ))}
      </div>
    );
  }
  if (preview.kind === "pptx") {
    return (
      <div className="flex flex-col gap-3">
        {preview.presentation.slides.map((slide) => (
          <Card key={slide.id} className="gap-2 py-3 shadow-none">
            <CardHeader className="gap-1 px-3">
              <CardTitle className="text-xs">Slide {slide.index + 1}</CardTitle>
              {slide.notes ? <CardDescription>{slide.notes}</CardDescription> : null}
            </CardHeader>
            <CardContent className="whitespace-pre-wrap px-3 text-sm leading-5">
              {slide.text || "No slide text"}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  if (preview.kind === "xlsx") {
    return (
      <div className="flex flex-col gap-3">
        {preview.workbook.sheets.map((sheet) => (
          <Card key={sheet.name} className="gap-2 py-3 shadow-none">
            <CardHeader className="px-3">
              <CardTitle className="text-xs">{sheet.name}</CardTitle>
            </CardHeader>
            <CardContent className="px-3">
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {sheet.cells.slice(0, 100).map((cell) => (
                  <div key={cell.address} className="contents">
                    <span className="font-mono text-muted-foreground">{cell.address}</span>
                    <span className="truncate">{String(cell.formula ?? cell.value ?? "")}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span>{preview.metadata.mimeType}</span>
      <span className="text-muted-foreground">{formatBytes(preview.metadata.sizeBytes)}</span>
      <span className="break-all font-mono text-muted-foreground">{preview.metadata.sha256}</span>
    </div>
  );
}

function ArtifactWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Card className="gap-2 border-warning/35 bg-warning/5 py-3 shadow-none">
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-2 text-xs">
          <AlertTriangleIcon className="size-3.5 text-warning" />
          Preview caveats
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-5 text-muted-foreground">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ComparisonContent({ comparison }: { comparison: ArtifactDiff }) {
  const { summary } = comparison;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary">{summary.totalChanges} changes</Badge>
        <Badge variant="outline">{summary.added} added</Badge>
        <Badge variant="outline">{summary.removed} removed</Badge>
        <Badge variant="outline">{summary.modified} modified</Badge>
        {summary.moved > 0 ? <Badge variant="outline">{summary.moved} moved</Badge> : null}
      </div>
      {comparison.kind === "text" ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
          {comparison.unifiedDiff || "No textual changes."}
        </pre>
      ) : (
        <div className="flex flex-col gap-2">
          {comparison.changes.slice(0, 100).map((change) => (
            <pre
              key={JSON.stringify(change)}
              className="overflow-x-auto rounded-md border border-border bg-muted/35 p-2 font-mono text-[11px] leading-4"
            >
              {JSON.stringify(change, null, 2)}
            </pre>
          ))}
        </div>
      )}
      {comparison.truncated ? (
        <p className="text-xs text-muted-foreground">
          The comparison is truncated after {comparison.changeLimit} changes.
        </p>
      ) : null}
      <ArtifactWarnings warnings={comparison.warnings} />
    </div>
  );
}

function ReviewStatus({ detail }: { detail: TaskArtifactDetail | null }) {
  if (!detail) return <Badge variant="outline">Loading history</Badge>;
  if (detail.activeRevision) {
    return <Badge variant="secondary">Revision {detail.activeRevision.status}</Badge>;
  }
  if (!detail.latestVersionId) return <Badge variant="outline">No versions</Badge>;
  if (detail.acceptedVersionId === detail.latestVersionId) {
    return <Badge variant="secondary">Accepted</Badge>;
  }
  return <Badge variant="outline">Needs review</Badge>;
}

export function ArtifactReviewCard({
  taskId,
  taskRevision,
  taskStatus,
  artifact,
  onOpenFile,
}: ArtifactReviewCardProps) {
  const readArtifact = useAppStore((state) => state.readTaskArtifact);
  const captureVersion = useAppStore((state) => state.captureTaskArtifactVersion);
  const compareVersions = useAppStore((state) => state.compareTaskArtifactVersions);
  const previewVersion = useAppStore((state) => state.previewTaskArtifactVersion);
  const restoreVersion = useAppStore((state) => state.restoreTaskArtifactVersion);
  const acceptVersion = useAppStore((state) => state.acceptTaskArtifactVersion);
  const startRevision = useAppStore((state) => state.startTaskArtifactRevision);
  const [detail, setDetail] = useState<TaskArtifactDetail | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [comparison, setComparison] = useState<ArtifactDiff | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const loadedDetailKeyRef = useRef<string | null>(null);
  const detailRequestKey = `${taskId}:${artifact.id}:${taskRevision}`;
  const terminal =
    taskStatus === "completed" || taskStatus === "cancelled" || taskStatus === "failed";
  const terminalRevisionNoticeId = `artifact-revision-lock-${taskId}-${artifact.id}`;
  const terminalRevisionCopy =
    taskStatus === "failed"
      ? "Retry the task before requesting artifact changes."
      : "Reopen the task before requesting artifact changes.";

  useEffect(() => {
    if (terminal && revisionOpen) setRevisionOpen(false);
  }, [revisionOpen, terminal]);

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    const next = await readArtifact(taskId, artifact.id);
    setLoadingDetail(false);
    if (!next) return null;
    setDetail(next);
    setSelectedVersionId((current) =>
      current && next.versions.some((version) => version.id === current)
        ? current
        : next.latestVersionId,
    );
    return next;
  }, [artifact.id, readArtifact, taskId]);

  useEffect(() => {
    if (loadedDetailKeyRef.current === detailRequestKey) return;
    loadedDetailKeyRef.current = detailRequestKey;
    setLoadingDetail(true);
    void readArtifact(taskId, artifact.id).then((next) => {
      if (loadedDetailKeyRef.current !== detailRequestKey) return;
      setLoadingDetail(false);
      if (!next) return;
      setDetail(next);
      setSelectedVersionId(next.latestVersionId);
    });
  }, [artifact.id, detailRequestKey, readArtifact, taskId]);

  const sortedVersions = useMemo(
    () => [...(detail?.versions ?? [])].sort((left, right) => right.version - left.version),
    [detail?.versions],
  );
  const latestVersion =
    sortedVersions.find((version) => version.id === detail?.latestVersionId) ?? null;
  const acceptedVersion =
    sortedVersions.find((version) => version.id === detail?.acceptedVersionId) ?? null;
  const selectedVersion =
    sortedVersions.find((version) => version.id === selectedVersionId) ?? null;
  const comparisonBase = selectedVersion
    ? versionBefore(detail?.versions ?? [], selectedVersion)
    : null;

  useEffect(() => {
    if (!reviewOpen || !selectedVersion) {
      setPreview(null);
      setComparison(null);
      setLoadingVersion(false);
      return;
    }
    let cancelled = false;
    setLoadingVersion(true);
    void Promise.all([
      previewVersion(taskId, artifact.id, selectedVersion.id),
      comparisonBase
        ? compareVersions(taskId, artifact.id, comparisonBase.id, selectedVersion.id)
        : Promise.resolve(null),
    ]).then(([previewResult, comparisonResult]) => {
      if (cancelled) return;
      setPreview(previewResult?.preview ?? null);
      setComparison(comparisonResult);
      setLoadingVersion(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    artifact.id,
    compareVersions,
    comparisonBase,
    previewVersion,
    reviewOpen,
    selectedVersion,
    taskId,
  ]);

  const runDetailMutation = async (
    key: string,
    operation: () => Promise<TaskArtifactDetail | null>,
  ) => {
    setPendingAction(key);
    try {
      const next = await operation();
      if (next) {
        setDetail(next);
        setSelectedVersionId(next.latestVersionId);
      }
      return next;
    } finally {
      setPendingAction(null);
    }
  };

  const captureCurrent = async () => {
    await runDetailMutation("capture", () =>
      captureVersion(taskId, artifact.id, "Captured from artifact review"),
    );
  };

  const acceptSelected = async () => {
    if (!selectedVersion) return;
    await runDetailMutation("accept", () => acceptVersion(taskId, artifact.id, selectedVersion.id));
  };

  const restoreSelected = async () => {
    if (!selectedVersion) return;
    const next = await runDetailMutation("restore", () =>
      restoreVersion(taskId, artifact.id, selectedVersion.id),
    );
    if (next) setRestoreConfirmOpen(false);
  };

  const submitRevision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (terminal || !selectedVersion || !instruction.trim()) return;
    const next = await runDetailMutation("revision", () =>
      startRevision(taskId, artifact.id, selectedVersion.id, instruction),
    );
    if (next) {
      setInstruction("");
      setRevisionOpen(false);
      setReviewOpen(false);
    }
  };

  return (
    <>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <Card className="gap-2 py-3 shadow-none" data-artifact-id={artifact.id}>
          <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 px-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-xs">
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{artifact.title}</span>
              </CardTitle>
              <CardDescription className="mt-1 truncate text-[10px]" title={artifact.path}>
                {artifact.path}
              </CardDescription>
            </div>
            <ReviewStatus detail={detail} />
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-2 px-3">
            <span className="text-[10px] text-muted-foreground">
              {loadingDetail
                ? "Loading versions…"
                : latestVersion
                  ? `Latest v${latestVersion.version} · ${acceptedVersion ? `Accepted v${acceptedVersion.version}` : "Not accepted"}`
                  : "No captured versions"}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onOpenFile(artifact.path)}
              >
                <EyeIcon data-icon="inline-start" />
                Open
              </Button>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setReviewOpen(true);
                    if (!detail && !loadingDetail) void loadDetail();
                  }}
                >
                  <HistoryIcon data-icon="inline-start" />
                  {terminal ? "Review versions" : "Revise this"}
                </Button>
              </DialogTrigger>
            </div>
          </CardContent>
        </Card>

        {reviewOpen ? (
          <DialogContent className="h-[min(52rem,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-[72rem] grid-rows-[auto_minmax(0,1fr)_auto] p-0 sm:max-w-[72rem]">
            <DialogHeader className="px-6 pt-6">
              <DialogTitle>{artifact.title}</DialogTitle>
              <DialogDescription>
                Review immutable versions, compare changes, restore a draft, or request a focused
                revision.
              </DialogDescription>
            </DialogHeader>

            <div className="grid min-h-0 grid-cols-[15rem_minmax(0,1fr)] border-y border-border">
              <ScrollArea className="min-h-0 border-r border-border">
                <div className="flex flex-col gap-1 p-3">
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Version history
                  </p>
                  {loadingDetail ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                      <Spinner /> Loading history
                    </div>
                  ) : sortedVersions.length === 0 ? (
                    <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">
                      Capture the current file to begin version history.
                    </p>
                  ) : (
                    sortedVersions.map((version) => {
                      const selected = version.id === selectedVersionId;
                      return (
                        <Button
                          key={version.id}
                          type="button"
                          variant="ghost"
                          className={cn(
                            "h-auto min-w-0 justify-start px-2 py-2 text-left",
                            selected && "bg-muted",
                          )}
                          aria-current={selected ? "true" : undefined}
                          onClick={() => setSelectedVersionId(version.id)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                            <span className="flex w-full items-center gap-1">
                              <span className="font-medium">{versionLabel(version)}</span>
                              {version.id === detail?.latestVersionId ? (
                                <Badge variant="outline">Latest</Badge>
                              ) : null}
                              {version.id === detail?.acceptedVersionId ? (
                                <Badge variant="secondary">Accepted</Badge>
                              ) : null}
                            </span>
                            <span className="line-clamp-2 text-[10px] font-normal leading-4 text-muted-foreground">
                              {version.changeSummary || "No change summary"}
                            </span>
                          </span>
                        </Button>
                      );
                    })
                  )}
                </div>
              </ScrollArea>

              <ScrollArea className="min-h-0">
                <div className="flex flex-col gap-5 p-5">
                  {selectedVersion ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{versionLabel(selectedVersion)}</Badge>
                        <Badge variant="outline">{formatBytes(selectedVersion.sizeBytes)}</Badge>
                        <Badge variant="outline">{selectedVersion.mediaType}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatTimestamp(selectedVersion.createdAt)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-semibold">Change summary</h3>
                        <p className="text-sm leading-6 text-muted-foreground">
                          {selectedVersion.changeSummary || "No change summary was recorded."}
                        </p>
                      </div>
                      <Separator />
                      <div className="flex flex-col gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <EyeIcon className="size-4" /> Preview
                        </h3>
                        {loadingVersion ? (
                          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                            <Spinner /> Loading version…
                          </div>
                        ) : preview ? (
                          <>
                            <PreviewContent preview={preview} />
                            <ArtifactWarnings warnings={preview.warnings} />
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">Preview unavailable.</p>
                        )}
                      </div>
                      {comparisonBase ? (
                        <>
                          <Separator />
                          <div className="flex flex-col gap-2">
                            <h3 className="flex items-center gap-2 text-sm font-semibold">
                              <GitCompareArrowsIcon className="size-4" /> Compared with{" "}
                              {versionLabel(comparisonBase)}
                            </h3>
                            {loadingVersion ? (
                              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                                <Spinner /> Comparing versions…
                              </div>
                            ) : comparison ? (
                              <ComparisonContent comparison={comparison} />
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                Comparison unavailable.
                              </p>
                            )}
                          </div>
                        </>
                      ) : null}
                      <Separator />
                      <div className="flex flex-col gap-2">
                        <h3 className="text-sm font-semibold">Provenance</h3>
                        <pre className="overflow-x-auto rounded-md border border-border bg-muted/35 p-3 font-mono text-[11px] leading-4">
                          {JSON.stringify(selectedVersion.provenance, null, 2)}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <FileClockIcon className="size-8" />
                      <p>No artifact version is selected.</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            <DialogFooter className="px-6 pb-6">
              <Button type="button" variant="outline" onClick={() => onOpenFile(artifact.path)}>
                <FileIcon data-icon="inline-start" />
                Open current file
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pendingAction !== null}
                onClick={() => void captureCurrent()}
              >
                {pendingAction === "capture" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                Capture current
              </Button>
              {selectedVersion && selectedVersion.id !== detail?.latestVersionId ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pendingAction !== null}
                  onClick={() => setRestoreConfirmOpen(true)}
                >
                  <RotateCcwIcon data-icon="inline-start" />
                  Restore draft
                </Button>
              ) : null}
              {selectedVersion && selectedVersion.id !== detail?.acceptedVersionId ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pendingAction !== null}
                  onClick={() => void acceptSelected()}
                >
                  {pendingAction === "accept" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <CheckCircle2Icon data-icon="inline-start" />
                  )}
                  Accept
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={terminal || !selectedVersion || pendingAction !== null}
                aria-disabled={terminal || undefined}
                aria-describedby={terminal ? terminalRevisionNoticeId : undefined}
                onClick={() => {
                  if (!terminal) setRevisionOpen(true);
                }}
              >
                <SendIcon data-icon="inline-start" />
                Request changes
              </Button>
              {terminal ? (
                <p
                  id={terminalRevisionNoticeId}
                  role="status"
                  className="basis-full text-xs text-muted-foreground"
                >
                  {terminalRevisionCopy}
                </p>
              ) : null}
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={restoreConfirmOpen} onOpenChange={setRestoreConfirmOpen}>
        {restoreConfirmOpen ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Restore this version as the draft?</DialogTitle>
              <DialogDescription>
                The current workspace file will be replaced from{" "}
                {selectedVersion ? versionLabel(selectedVersion) : "this version"}. Existing version
                history remains available.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRestoreConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!selectedVersion || pendingAction !== null}
                onClick={() => void restoreSelected()}
              >
                {pendingAction === "restore" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RotateCcwIcon data-icon="inline-start" />
                )}
                Restore draft
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={revisionOpen}
        onOpenChange={(open) => {
          if (!terminal) setRevisionOpen(open);
        }}
      >
        {revisionOpen ? (
          <DialogContent>
            <form onSubmit={submitRevision}>
              <DialogHeader>
                <DialogTitle>Request artifact changes</DialogTitle>
                <DialogDescription>
                  Cowork will create a focused task thread from{" "}
                  {selectedVersion ? versionLabel(selectedVersion) : "the selected version"} and
                  preserve every other artifact.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="py-5">
                <Field>
                  <FieldLabel htmlFor={`artifact-revision-${artifact.id}`}>Instructions</FieldLabel>
                  <Textarea
                    id={`artifact-revision-${artifact.id}`}
                    autoFocus
                    className="min-h-32"
                    placeholder="Keep the analysis, update the recommendation, and revise only this artifact."
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setRevisionOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!selectedVersion || !instruction.trim() || pendingAction !== null}
                >
                  {pendingAction === "revision" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SendIcon data-icon="inline-start" />
                  )}
                  Request changes
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
