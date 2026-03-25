import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  memoryListEventSchema,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcMemoryRequestSchemas = {
  "cowork/memory/list": jsonRpcControlRequestSchemas["cowork/memory/list"],
  "cowork/memory/upsert": jsonRpcControlRequestSchemas["cowork/memory/upsert"],
  "cowork/memory/delete": jsonRpcControlRequestSchemas["cowork/memory/delete"],
} as const;

export const jsonRpcMemoryResultSchemas = {
  "cowork/memory/list": jsonRpcControlResultSchemas["cowork/memory/list"],
  "cowork/memory/upsert": jsonRpcControlResultSchemas["cowork/memory/upsert"],
  "cowork/memory/delete": jsonRpcControlResultSchemas["cowork/memory/delete"],
} as const;
