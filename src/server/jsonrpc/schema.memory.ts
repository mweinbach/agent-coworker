import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcMemoryRequestSchemas = {
  "cowork/memory/list": jsonRpcControlRequestSchemas["cowork/memory/list"],
  "cowork/memory/upsert": jsonRpcControlRequestSchemas["cowork/memory/upsert"],
  "cowork/memory/delete": jsonRpcControlRequestSchemas["cowork/memory/delete"],
  "cowork/advanced-memory/list": jsonRpcControlRequestSchemas["cowork/advanced-memory/list"],
  "cowork/advanced-memory/upsert": jsonRpcControlRequestSchemas["cowork/advanced-memory/upsert"],
  "cowork/advanced-memory/delete": jsonRpcControlRequestSchemas["cowork/advanced-memory/delete"],
} as const;

export const jsonRpcMemoryResultSchemas = {
  "cowork/memory/list": jsonRpcControlResultSchemas["cowork/memory/list"],
  "cowork/memory/upsert": jsonRpcControlResultSchemas["cowork/memory/upsert"],
  "cowork/memory/delete": jsonRpcControlResultSchemas["cowork/memory/delete"],
  "cowork/advanced-memory/list": jsonRpcControlResultSchemas["cowork/advanced-memory/list"],
  "cowork/advanced-memory/upsert": jsonRpcControlResultSchemas["cowork/advanced-memory/upsert"],
  "cowork/advanced-memory/delete": jsonRpcControlResultSchemas["cowork/advanced-memory/delete"],
} as const;
