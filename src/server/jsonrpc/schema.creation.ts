import {
  creationPreflightParamsSchema,
  creationPreflightResultSchema,
} from "../../shared/creationReadiness";

export const jsonRpcCreationRequestSchemas = {
  "cowork/creation/preflight": creationPreflightParamsSchema,
} as const;

export const jsonRpcCreationResultSchemas = {
  "cowork/creation/preflight": creationPreflightResultSchema,
} as const;
