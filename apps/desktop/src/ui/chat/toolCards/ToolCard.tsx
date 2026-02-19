import { memo, useMemo, useState } from "react";

import {
  Tool,
  ToolCodeBlock,
  ToolContent,
  ToolHeader,
} from "../../../components/ai-elements/tool";

import { formatToolCard } from "./toolCardFormatting";

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
    [displayName, props.args, props.result, props.status],
  );

  return (
    <Tool open={expanded} onOpenChange={setExpanded}>
      <ToolHeader title={formatting.title} subtitle={formatting.subtitle} status={props.status} />
      <ToolContent>
        {argsJson ? <ToolCodeBlock label="Input" value={argsJson} /> : null}
        {resultJson ? <ToolCodeBlock label="Output" value={resultJson} tone={props.status === "error" ? "error" : "default"} /> : null}
      </ToolContent>
    </Tool>
  );
});
