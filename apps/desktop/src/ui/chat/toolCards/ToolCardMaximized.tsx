import { memo } from "react";

type ToolCardMaximizedProps = {
  argsJson: string;
  resultJson: string;
};

export const ToolCardMaximized = memo(function ToolCardMaximized(props: ToolCardMaximizedProps) {
  return (
    <div className="toolCallDetails">
      {props.argsJson && (
        <div className="toolCallSection">
          <div className="toolCallSectionLabel">Arguments</div>
          <pre className="toolCallPre">{props.argsJson}</pre>
        </div>
      )}

      {props.resultJson && (
        <div className="toolCallSection">
          <div className="toolCallSectionLabel">Result</div>
          <pre className="toolCallPre">{props.resultJson}</pre>
        </div>
      )}
    </div>
  );
});
