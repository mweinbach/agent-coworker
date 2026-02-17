import { memo, useCallback, useMemo, useState, type KeyboardEvent } from "react";

import { formatToolCard } from "./toolCardFormatting";
import { ToolCardMaximized } from "./ToolCardMaximized";
import { ToolCardMinimized } from "./ToolCardMinimized";

type ToolCardProps = {
  args?: unknown;
  name: string;
  result?: unknown;
  status: "running" | "done" | "error";
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
  const [expanded, setExpanded] = useState(false);

  const displayName = useMemo(() => {
    if (props.name === "tool" && isRecord(props.args) && typeof props.args.name === "string") {
      return props.args.name;
    }
    return props.name;
  }, [props.args, props.name]);

  const argsJson = useMemo(() => toJson(props.args), [props.args]);
  const resultJson = useMemo(() => toJson(props.result), [props.result]);
  const formatting = useMemo(
    () => formatToolCard(displayName, props.args, props.result, props.status),
    [displayName, props.args, props.result, props.status]
  );

  const toggle = useCallback(() => {
    setExpanded((isExpanded) => !isExpanded);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    toggle();
  }, [toggle]);

  return (
    <div className="feedItem">
      <div
        className="toolCallCard"
        data-expanded={expanded}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={onKeyDown}
      >
        <ToolCardMinimized
          expanded={expanded}
          subtitle={formatting.subtitle}
          title={formatting.title}
          onToggle={toggle}
          status={props.status}
        />
        {expanded ? <ToolCardMaximized argsJson={argsJson} details={formatting.details} resultJson={resultJson} /> : null}
      </div>
    </div>
  );
});
