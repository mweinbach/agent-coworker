import type { AgentConfig } from "../../types";
import type { ResearchService } from "../research/ResearchService";
import type { SessionDb } from "../sessionDb";
import type { SocketSendQueue } from "./SocketSendQueue";
import type { SessionRegistry } from "./SessionRegistry";
import type { SkillMutationBus } from "./SkillMutationBus";
import type { ThreadJournal } from "./ThreadJournal";
import type { WorkspaceControl } from "./WorkspaceControl";

export type ServerRuntime = {
  getConfig(): AgentConfig;
  setConfig(config: AgentConfig): void;
  sessionDb: SessionDb;
  research: ResearchService;
  sessions: SessionRegistry;
  workspaceControl: WorkspaceControl;
  threadJournal: ThreadJournal;
  socketSendQueue: SocketSendQueue;
  skillMutationBus: SkillMutationBus;
};
