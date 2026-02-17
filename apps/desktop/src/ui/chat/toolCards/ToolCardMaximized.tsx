import { memo } from "react";

type ToolCardDetail = {
  label: string;
  value: string;
};

type ToolCardMaximizedProps = {
  argsJson: string;
  details: ToolCardDetail[];
  resultJson: string;
};

export const ToolCardMaximized = memo(function ToolCardMaximized(props: ToolCardMaximizedProps) {
  return (
    <div className="toolCallDetails">
      {props.details.length > 0 ? (
        <div className="toolCallKeyFacts">
          {props.details.map((detail) => (
            <div key={`${detail.label}:${detail.value}`} className="toolCallFactRow">
              <div className="toolCallFactLabel">{detail.label}</div>
              <div className="toolCallFactValue">{detail.value}</div>
            </div>
          ))}
        </div>
      ) : null}

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
