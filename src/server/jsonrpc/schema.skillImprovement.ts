import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcSkillImprovementRequestSchemas = {
  "cowork/skills/improvement/status":
    jsonRpcControlRequestSchemas["cowork/skills/improvement/status"],
  "cowork/skills/improvement/run": jsonRpcControlRequestSchemas["cowork/skills/improvement/run"],
  "cowork/skills/improvement/restore":
    jsonRpcControlRequestSchemas["cowork/skills/improvement/restore"],
} as const;

export const jsonRpcSkillImprovementResultSchemas = {
  "cowork/skills/improvement/status":
    jsonRpcControlResultSchemas["cowork/skills/improvement/status"],
  "cowork/skills/improvement/run": jsonRpcControlResultSchemas["cowork/skills/improvement/run"],
  "cowork/skills/improvement/restore":
    jsonRpcControlResultSchemas["cowork/skills/improvement/restore"],
} as const;
