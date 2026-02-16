import { Switch, Match } from "solid-js";
import { BashTool } from "../tool/bash";
import { ReadTool } from "../tool/read";
import { WriteTool } from "../tool/write";
import { EditTool } from "../tool/edit";
import { GlobTool } from "../tool/glob";
import { GrepTool } from "../tool/grep";
import { WebTool } from "../tool/web";
import { TodoTool } from "../tool/todo";
import { GenericTool } from "../tool/generic";

export type ToolPartProps = {
  name: string;
  sub?: string;
  status: "running" | "done";
  args?: any;
  result?: any;
};

export function ToolPart(props: ToolPartProps) {
  return (
    <Switch fallback={<GenericTool {...props} />}>
      <Match when={props.name === "bash"}>
        <BashTool {...props} />
      </Match>
      <Match when={props.name === "read"}>
        <ReadTool {...props} />
      </Match>
      <Match when={props.name === "write"}>
        <WriteTool {...props} />
      </Match>
      <Match when={props.name === "edit"}>
        <EditTool {...props} />
      </Match>
      <Match when={props.name === "glob"}>
        <GlobTool {...props} />
      </Match>
      <Match when={props.name === "grep"}>
        <GrepTool {...props} />
      </Match>
      <Match when={props.name === "webFetch" || props.name === "webSearch"}>
        <WebTool {...props} />
      </Match>
      <Match when={props.name === "todoWrite"}>
        <TodoTool {...props} />
      </Match>
    </Switch>
  );
}
