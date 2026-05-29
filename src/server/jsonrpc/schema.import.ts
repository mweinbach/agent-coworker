import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcImportRequestSchemas = {
  "cowork/import/list": jsonRpcControlRequestSchemas["cowork/import/list"],
  "cowork/import/plugin": jsonRpcControlRequestSchemas["cowork/import/plugin"],
  "cowork/import/skill": jsonRpcControlRequestSchemas["cowork/import/skill"],
} as const;

export const jsonRpcImportResultSchemas = {
  "cowork/import/list": jsonRpcControlResultSchemas["cowork/import/list"],
  "cowork/import/plugin": jsonRpcControlResultSchemas["cowork/import/plugin"],
  "cowork/import/skill": jsonRpcControlResultSchemas["cowork/import/skill"],
} as const;
