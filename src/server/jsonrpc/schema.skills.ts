import { pickJsonRpcControlSchemas } from "../../shared/jsonrpcControlSchemas";

const skillsControlSchemas = pickJsonRpcControlSchemas([
  "cowork/skills/catalog/read",
  "cowork/skills/list",
  "cowork/skills/read",
  "cowork/skills/disable",
  "cowork/skills/enable",
  "cowork/skills/delete",
  "cowork/skills/installation/read",
  "cowork/skills/install/preview",
  "cowork/skills/install",
  "cowork/skills/installation/enable",
  "cowork/skills/installation/disable",
  "cowork/skills/installation/delete",
  "cowork/skills/installation/update",
  "cowork/skills/installation/copy",
  "cowork/skills/installation/checkUpdate",
] as const);

export const jsonRpcSkillsRequestSchemas = skillsControlSchemas.requests;

export const jsonRpcSkillsResultSchemas = skillsControlSchemas.results;
