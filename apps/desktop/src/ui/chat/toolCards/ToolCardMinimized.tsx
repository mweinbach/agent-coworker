import { memo } from "react";

type ToolCardMinimizedProps = {
  expanded: boolean;
  name: string;
  onToggle: () => void;
  status: "running" | "done" | "error";
};

const IconTerminal = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"></polyline>
    <line x1="12" y1="19" x2="20" y2="19"></line>
  </svg>
);

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const IconError = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

const STATUS_LABEL: Record<"running" | "done" | "error", string> = {
  running: "Running",
  done: "Done",
  error: "Error",
};

export const ToolCardMinimized = memo(function ToolCardMinimized(props: ToolCardMinimizedProps) {
  return (
    <div className="toolCallHeader" onClick={props.onToggle}>
      <div className="toolCallInfo">
        <div className={`toolStatusDot ${props.status}`} />
        <IconTerminal />
        <span className="toolCallName">{props.name}</span>
      </div>

      <div className="toolCallAction">
        {props.status === "done" && <IconCheck />}
        {props.status === "running" && <div className="spinner-mini" />}
        {props.status === "error" && <IconError />}
        <span className={`toolCallMeta ${props.status}`}>{STATUS_LABEL[props.status]}</span>
        <span className="expandIcon">{props.expanded ? "▾" : "▸"}</span>
      </div>
    </div>
  );
});
