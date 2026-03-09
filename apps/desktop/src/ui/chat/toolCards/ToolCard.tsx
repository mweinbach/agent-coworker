import { memo, useEffect, useMemo, useState } from "react";

import type { ToolApprovalMetadata, ToolFeedState } from "../../../app/types";

import {
  Tool,
  ToolCodeBlock,
  ToolContent,
  ToolHeader,
} from "../../../components/ai-elements/tool";

import { formatToolCard } from "./toolCardFormatting";

type ToolCardProps = {
  approval?: ToolApprovalMetadata;
  args?: unknown;
  name: string;
  result?: unknown;
  state: ToolFeedState;
  variant?: "default" | "trace";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const ToolCard = memo(function ToolCard(props: ToolCardProps) {
  const shouldAutoExpand =
    props.state === "approval-requested" ||
    props.state === "output-error" ||
    props.state === "output-denied";

  const displayName = useMemo(() => {
    if (props.name === "tool" && isRecord(props.args) && typeof props.args.name === "string") {
      return props.args.name;
    }
    return props.name;
  }, [props.args, props.name]);

  const approvalJson = useMemo(() => toJson(props.approval), [props.approval]);
  const argsJson = useMemo(() => toJson(props.args), [props.args]);
  const resultJson = useMemo(() => toJson(props.result), [props.result]);
  const formatting = useMemo(
    () => formatToolCard(displayName, props.args, props.result, props.state),
    [displayName, props.args, props.result, props.state],
  );
  const detailRows = useMemo(
    () => formatting.details.filter((row) => row.label !== "Status"),
    [formatting.details],
  );
  const hasExpandableContent = props.variant === "trace"
    ? detailRows.length > 0
    : Boolean(approvalJson || argsJson || resultJson);
  const [expanded, setExpanded] = useState(shouldAutoExpand && hasExpandableContent);

  useEffect(() => {
    if (shouldAutoExpand && hasExpandableContent) {
      setExpanded(true);
    }
  }, [hasExpandableContent, shouldAutoExpand]);

  if (props.variant === "trace") {
    return (
      <Tool variant="trace" open={expanded} onOpenChange={setExpanded}>
        <ToolHeader
          showChevron={hasExpandableContent}
          state={props.state}
          subtitle={formatting.subtitle}
          title={formatting.title}
          variant="trace"
        />
        {hasExpandableContent ? (
          <ToolContent variant="trace">
            <div className="grid gap-2 sm:grid-cols-2">
              {detailRows.map((row) => (
                <div key={`${props.name}-${row.label}`} className="rounded-lg border border-border/50 bg-muted/15 px-2.5 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {row.label}
                  </div>
                  <div className="mt-1 break-words text-xs leading-5 text-foreground/85">
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          </ToolContent>
        ) : null}
      </Tool>
    );
  }

  return (
    <Tool open={expanded} onOpenChange={setExpanded}>
      <ToolHeader
        showChevron={hasExpandableContent}
        state={props.state}
        subtitle={formatting.subtitle}
        title={formatting.title}
      />
      {hasExpandableContent ? (
        <ToolContent>
          {approvalJson ? (
            <ToolCodeBlock
              label="Approval"
              value={approvalJson}
              tone={props.state === "output-denied" ? "error" : "default"}
            />
          ) : null}
          {argsJson ? <ToolCodeBlock label="Input" value={argsJson} /> : null}
          {resultJson ? (
            <ToolCodeBlock
              label={props.state === "output-error" || props.state === "output-denied" ? "Issue" : "Output"}
              value={resultJson}
              tone={props.state === "output-error" || props.state === "output-denied" ? "error" : "default"}
            />
          ) : null}
        </ToolContent>
      ) : null}
    </Tool>
  );
});
