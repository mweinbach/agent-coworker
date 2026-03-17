import { For, Show, onMount } from "solid-js";
import { useDialog } from "../../context/dialog";
import { useRoute } from "../../context/route";
import { useSync } from "../../context/sync";
import { useTheme } from "../../context/theme";
import { showToast } from "../../ui/toast";
import { Dialog } from "../../ui/dialog";

type AgentSummary = ReturnType<typeof useSync>["state"]["agents"][number];

function formatAgentStatus(agent: AgentSummary): string {
  if (agent.lifecycleState === "closed") return "closed";
  if (agent.busy) return "busy";
  return agent.executionState.replace(/_/g, " ");
}

function AgentActionButton(props: {
  label: string;
  onPress: () => void;
  tone?: "default" | "warning";
}) {
  const theme = useTheme();
  const fg = () => (props.tone === "warning" ? theme.warning : theme.text);

  return (
    <box
      border
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onPress}
    >
      <text fg={fg()}>{props.label}</text>
    </box>
  );
}

function AgentCard(props: {
  agent: AgentSummary;
  onOpen: (agentId: string) => void;
  onResume: (agentId: string) => void;
  onClose: (agentId: string) => void;
  onWait: (agentId: string) => void;
}) {
  const theme = useTheme();

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.borderSubtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      marginBottom={1}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <strong>{props.agent.nickname || props.agent.title}</strong>
        </text>
        <text fg={props.agent.busy ? theme.warning : theme.textMuted}>
          {formatAgentStatus(props.agent)}
        </text>
      </box>
      <text fg={theme.textMuted}>
        {props.agent.role} · {props.agent.provider}/{props.agent.effectiveModel}
      </text>
      <text fg={theme.textMuted}>
        depth {props.agent.depth} · lifecycle {props.agent.lifecycleState}
        {props.agent.effectiveReasoningEffort ? ` · reasoning ${props.agent.effectiveReasoningEffort}` : ""}
      </text>
      <Show when={props.agent.lastMessagePreview}>
        {(preview) => (
          <text fg={theme.textMuted}>
            preview: {preview()}
          </text>
        )}
      </Show>
      <box flexDirection="row" gap={1} marginTop={1}>
        <AgentActionButton label="Open" onPress={() => props.onOpen(props.agent.agentId)} />
        <AgentActionButton label="Resume" onPress={() => props.onResume(props.agent.agentId)} />
        <AgentActionButton label="Wait" onPress={() => props.onWait(props.agent.agentId)} />
        <AgentActionButton label="Close" tone="warning" onPress={() => props.onClose(props.agent.agentId)} />
      </box>
    </box>
  );
}

export function openSubagentDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <SubagentDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function SubagentDialog(props: { onDismiss: () => void }) {
  const theme = useTheme();
  const { state, actions } = useSync();
  const route = useRoute();

  onMount(() => {
    actions.requestAgentList();
  });

  const openAgent = (agentId: string) => {
    route.navigate({ route: "session", sessionId: agentId });
    actions.resumeSession(agentId);
    props.onDismiss();
  };

  const resumeAgent = (agentId: string) => {
    if (!actions.resumeAgent(agentId)) {
      showToast("Unable to resume agent from this session", "error");
      return;
    }
    showToast("Child agent resume requested", "success");
  };

  const waitForAgent = (agentId: string) => {
    if (!actions.waitForAgents([agentId], 30000)) {
      showToast("Unable to wait on agent from this session", "error");
      return;
    }
    showToast("Waiting on child agent", "success");
  };

  const closeAgent = (agentId: string) => {
    if (!actions.closeAgent(agentId)) {
      showToast("Unable to close agent from this session", "error");
      return;
    }
    showToast("Child agent close requested", "success");
  };

  return (
    <Dialog onDismiss={props.onDismiss} width="72%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Agents</strong>
        </text>

        <Show
          when={state.sessionKind !== "agent"}
          fallback={
            <box flexDirection="column">
              <text fg={theme.textMuted}>
                This session is a child agent. Open the parent session to manage sibling agents.
              </text>
              <Show when={state.parentSessionId}>
                {(parentSessionId) => (
                  <box marginTop={1}>
                    <AgentActionButton
                      label="Open Parent"
                      onPress={() => {
                        route.navigate({ route: "session", sessionId: parentSessionId() });
                        actions.resumeSession(parentSessionId());
                        props.onDismiss();
                      }}
                    />
                  </box>
                )}
              </Show>
            </box>
          }
        >
          <box flexDirection="column">
            <text fg={theme.textMuted} marginBottom={1}>
              {state.agents.length} child agent{state.agents.length === 1 ? "" : "s"} tracked for this session.
            </text>
            <Show
              when={state.agents.length > 0}
              fallback={<text fg={theme.textMuted}>No child agents yet.</text>}
            >
              <scrollbox height={18}>
                <For each={state.agents}>
                  {(agent) => (
                    <AgentCard
                      agent={agent}
                      onOpen={openAgent}
                      onResume={resumeAgent}
                      onClose={closeAgent}
                      onWait={waitForAgent}
                    />
                  )}
                </For>
              </scrollbox>
            </Show>
          </box>
        </Show>

        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
