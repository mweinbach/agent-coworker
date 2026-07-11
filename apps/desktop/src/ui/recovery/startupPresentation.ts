import type { BootstrapStage } from "../../app/store.helpers";

export function startupStagePresentation(stage: BootstrapStage | null): {
  detail: string;
  title: string;
} {
  switch (stage) {
    case "restoring-workspace":
      return {
        title: "Restoring your workspace",
        detail: "Loading saved chats, drafts, and workspace settings.",
      };
    case "checking-services":
      return {
        title: "Checking desktop services",
        detail: "Confirming local services and update state.",
      };
    case "reconnecting-sessions":
      return {
        title: "Reconnecting recent sessions",
        detail: "Bringing your latest conversation back online.",
      };
    case null:
      return {
        title: "Starting Cowork",
        detail: "Preparing your desktop workspace.",
      };
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}
