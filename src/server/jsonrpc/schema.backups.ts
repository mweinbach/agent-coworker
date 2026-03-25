import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  workspaceBackupDeltaEventSchema,
  workspaceBackupsEventSchema,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcBackupsRequestSchemas = {
  "cowork/backups/workspace/read": jsonRpcControlRequestSchemas["cowork/backups/workspace/read"],
  "cowork/backups/workspace/delta/read": jsonRpcControlRequestSchemas["cowork/backups/workspace/delta/read"],
  "cowork/backups/workspace/checkpoint": jsonRpcControlRequestSchemas["cowork/backups/workspace/checkpoint"],
  "cowork/backups/workspace/restore": jsonRpcControlRequestSchemas["cowork/backups/workspace/restore"],
  "cowork/backups/workspace/deleteCheckpoint": jsonRpcControlRequestSchemas["cowork/backups/workspace/deleteCheckpoint"],
  "cowork/backups/workspace/deleteEntry": jsonRpcControlRequestSchemas["cowork/backups/workspace/deleteEntry"],
} as const;

export const jsonRpcBackupsResultSchemas = {
  "cowork/backups/workspace/read": jsonRpcControlResultSchemas["cowork/backups/workspace/read"],
  "cowork/backups/workspace/delta/read": jsonRpcControlResultSchemas["cowork/backups/workspace/delta/read"],
  "cowork/backups/workspace/checkpoint": jsonRpcControlResultSchemas["cowork/backups/workspace/checkpoint"],
  "cowork/backups/workspace/restore": jsonRpcControlResultSchemas["cowork/backups/workspace/restore"],
  "cowork/backups/workspace/deleteCheckpoint": jsonRpcControlResultSchemas["cowork/backups/workspace/deleteCheckpoint"],
  "cowork/backups/workspace/deleteEntry": jsonRpcControlResultSchemas["cowork/backups/workspace/deleteEntry"],
} as const;
