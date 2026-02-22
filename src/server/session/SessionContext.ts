import type { AgentConfig, ServerErrorCode, ServerErrorSource } from "../../types";
import type { ServerEvent } from "../protocol";

export type SessionContext = {
  id: string;
  config: AgentConfig;
  emit: (evt: ServerEvent) => void;
  emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
};
