import { For, Show, Switch, Match, createMemo } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncState } from "../../context/sync";
import { useKV } from "../../context/kv";
import { SessionHeader } from "./header";
import { SessionFooter } from "./footer";
import { SessionSidebar } from "./sidebar";
import { PermissionPrompt } from "./permission";
import { QuestionPrompt } from "./question";
import { Prompt } from "../../component/prompt/index";
import { UserMessage } from "../../component/message/user";
import { AssistantMessage } from "../../component/message/assistant";
import { ReasoningPart } from "../../component/message/reasoning-part";
import { ToolPart } from "../../component/message/tool-part";
import { TodoItem } from "../../component/todo-item";
import type { FeedItem } from "../../context/sync";

export function Session(props: { sessionId: string }) {
  const theme = useTheme();
  const syncState = useSyncState();
  const kv = useKV();

  const [sidebarOpen, setSidebarOpen] = kv.signal("sidebar_visible", true);

  // Show sidebar when terminal is wide enough
  // TODO: detect terminal width dynamically
  const showSidebar = createMemo(() => sidebarOpen());

  const hasInteraction = createMemo(() => {
    return syncState.pendingAsk !== null || syncState.pendingApproval !== null;
  });

  return (
    <box flexDirection="row" width="100%" height="100%">
      {/* Main content area */}
      <box flexDirection="column" flexGrow={1}>
        {/* Header */}
        <SessionHeader />

        {/* Message feed */}
        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
        >
          <For each={syncState.feed}>
            {(item) => <FeedItemRenderer item={item} />}
          </For>
        </scrollbox>

        {/* Interactive prompts */}
        <Show when={syncState.pendingApproval}>
          {(approval) => <PermissionPrompt approval={approval()} />}
        </Show>

        <Show when={syncState.pendingAsk}>
          {(ask) => <QuestionPrompt ask={ask()} />}
        </Show>

        {/* Input prompt */}
        <box paddingLeft={1} paddingRight={1} paddingBottom={1} flexShrink={0}>
          <Prompt disabled={hasInteraction()} />
        </box>

        {/* Footer */}
        <SessionFooter />
      </box>

      {/* Sidebar */}
      <Show when={showSidebar()}>
        <SessionSidebar />
      </Show>
    </box>
  );
}

function FeedItemRenderer(props: { item: FeedItem }) {
  const theme = useTheme();

  return (
    <Switch>
      <Match when={props.item.type === "message" && (props.item as any).role === "user"}>
        <UserMessage text={(props.item as any).text} />
      </Match>

      <Match when={props.item.type === "message" && (props.item as any).role === "assistant"}>
        <AssistantMessage text={(props.item as any).text} />
      </Match>

      <Match when={props.item.type === "reasoning"}>
        <ReasoningPart
          kind={(props.item as any).kind}
          text={(props.item as any).text}
        />
      </Match>

      <Match when={props.item.type === "tool"}>
        <ToolPart
          name={(props.item as any).name}
          sub={(props.item as any).sub}
          status={(props.item as any).status}
          args={(props.item as any).args}
          result={(props.item as any).result}
        />
      </Match>

      <Match when={props.item.type === "todos"}>
        <box flexDirection="column" marginBottom={1}>
          <For each={(props.item as any).todos}>
            {(todo: any) => <TodoItem todo={todo} />}
          </For>
        </box>
      </Match>

      <Match when={props.item.type === "system"}>
        <box marginBottom={0}>
          <text fg={theme.textMuted}>
            <em>{(props.item as any).line}</em>
          </text>
        </box>
      </Match>

      <Match when={props.item.type === "error"}>
        <box marginBottom={1}>
          <text fg={theme.error}>
            ✗ {(props.item as any).message}
          </text>
        </box>
      </Match>

      <Match when={props.item.type === "log"}>
        <box marginBottom={0}>
          <text fg={theme.textMuted}>{(props.item as any).line}</text>
        </box>
      </Match>
    </Switch>
  );
}
