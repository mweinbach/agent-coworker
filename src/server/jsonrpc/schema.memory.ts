import { pickJsonRpcControlSchemas } from "../../shared/jsonrpcControlSchemas";

const memoryControlSchemas = pickJsonRpcControlSchemas([
  "cowork/memory/list",
  "cowork/memory/upsert",
  "cowork/memory/delete",
  "cowork/memory/advanced/list",
  "cowork/memory/advanced/upsert",
  "cowork/memory/advanced/delete",
  "cowork/memory/advanced/generate",
  "cowork/memory/advanced/folder/list",
  "cowork/memory/advanced/folder/upsert",
  "cowork/memory/advanced/folder/delete",
  "cowork/memory/advanced/folder/generate",
] as const);

export const jsonRpcMemoryRequestSchemas = memoryControlSchemas.requests;

export const jsonRpcMemoryResultSchemas = memoryControlSchemas.results;
