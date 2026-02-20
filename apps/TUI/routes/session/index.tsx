import { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, Switch, Match, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncState } from "../../context/sync";
import { useKV } from "../../context/kv";
import { useDialog } from "../../context/dialog";
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
import { keyNameFromEvent } from "../../util/keyboard";

export function Session(props: { sessionId: string }) {
  const syncState = useSyncState();
  const kv = useKV();
  const dialog = useDialog();
  let feedScrollRef: ScrollBoxRenderable | undefined;

  const [sidebarOpen] = kv.signal("sidebar_visible", true);

  const [terminalWidth, setTerminalWidth] = createSignal(process.stdout.columns ?? 120);

  onMount(() => {
    const handleResize = () => setTerminalWidth(process.stdout.columns ?? 120);
    process.stdout.on("resize", handleResize);
    onCleanup(() => process.stdout.off("resize", handleResize));
  });

  const showSidebar = createMemo(() => sidebarOpen() && terminalWidth() > 120);

  const hasInteraction = createMemo(() => {
    return syncState.pendingAsk !== null || syncState.pendingApproval !== null;
  });

  useKeyboard((e) => {
    if ((e as { defaultPrevented?: boolean }).defaultPrevented) return;
    if (dialog.hasDialog()) return;

    const key = keyNameFromEvent(e);
    if (key !== "pageup" && key !== "pagedown" && e.repeated) return;

    if (key === "pageup") {
      feedScrollRef?.scrollBy(-0.5, "viewport");
      e.preventDefault?.();
      e.stopPropagation?.();
      return;
    }

    if (key === "pagedown") {
      feedScrollRef?.scrollBy(0.5, "viewport");
      e.preventDefault?.();
      e.stopPropagation?.();
    }
  });

  return (
    <box flexDirection="row" width="100%" height="100%">
      {/* Main content area */}
      <box flexDirection="column" flexGrow={1}>
        {/* Header */}
        <SessionHeader />

        {/* Message feed */}
        <scrollbox
          ref={(el) => {
            feedScrollRef = el;
          }}
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

      <Match when={props.item.type === "skill_content"}>
        <box
          border
          borderStyle="rounded"
          borderColor={theme.borderSubtle}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          flexDirection="column"
        >
          <text fg={theme.text}>
            <strong>Skill Content</strong>
          </text>
          <text fg={theme.textMuted}>
            {(props.item as any).skill.name} ({(props.item as any).skill.source})
          </text>
          <text fg={theme.textMuted}>
            {summarizePlainText((props.item as any).content, 320)}
          </text>
        </box>
      </Match>

      <Match when={props.item.type === "session_backup_state"}>
        <box
          border
          borderStyle="rounded"
          borderColor={theme.borderSubtle}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          flexDirection="column"
        >
          <text fg={theme.text}>
            <strong>Session Backup</strong>
          </text>
          <text fg={theme.textMuted}>
            reason: {(props.item as any).reason} · status: {(props.item as any).backup.status}
          </text>
          <text fg={theme.textMuted}>
            checkpoints: {(props.item as any).backup.checkpoints.length}
          </text>
          <Show when={(props.item as any).backup.checkpoints.length > 0}>
            {() => {
              const latest = (props.item as any).backup.checkpoints[
                (props.item as any).backup.checkpoints.length - 1
              ];
              return (
                <text fg={theme.textMuted}>
                  latest: {latest.id} ({latest.trigger}, {latest.changed ? "changed" : "unchanged"}, {formatBytes(latest.patchBytes)})
                </text>
              );
            }}
          </Show>
        </box>
      </Match>
    </Switch>
  );
}

function summarizePlainText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
