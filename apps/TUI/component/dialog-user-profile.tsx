import { createMemo } from "solid-js";
import { DialogPrompt } from "../ui/dialog-prompt";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useSyncActions, useSyncState } from "../context/sync";

export function openUserProfileDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <UserProfileDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function UserProfileDialog(props: { onDismiss: () => void }) {
  const dialog = useDialog();
  const syncState = useSyncState();

  const items = createMemo((): SelectItem[] => {
    const profile = syncState.userProfile;
    return [
      {
        label: "Edit Name",
        value: "name",
        description: syncState.userName.trim() || "Not set",
      },
      {
        label: "Edit Work/Job",
        value: "work",
        description: profile.work.trim() || "Not set",
      },
      {
        label: "Edit Instructions",
        value: "instructions",
        description: profile.instructions.trim() || "Not set",
      },
      {
        label: "Edit Details Agent Should Know",
        value: "details",
        description: profile.details.trim() || "Not set",
      },
    ];
  });

  const openEditor = (field: "name" | "work" | "instructions" | "details") => {
    dialog.push(
      () => <UserProfileFieldDialog field={field} onDismiss={() => dialog.pop()} />,
      () => {}
    );
  };

  return (
    <DialogSelect
      items={items()}
      onDismiss={props.onDismiss}
      title="User Profile"
      placeholder="Choose a field to edit"
      onSelect={(item) => {
        if (item.value === "name" || item.value === "work" || item.value === "instructions" || item.value === "details") {
          openEditor(item.value);
        }
      }}
    />
  );
}

function UserProfileFieldDialog(props: { field: "name" | "work" | "instructions" | "details"; onDismiss: () => void }) {
  const syncState = useSyncState();
  const syncActions = useSyncActions();

  const title = createMemo(() => {
    switch (props.field) {
      case "name":
        return "User Profile: Name";
      case "work":
        return "User Profile: Work/Job";
      case "instructions":
        return "User Profile: Instructions";
      case "details":
        return "User Profile: Details Agent Should Know";
    }
  });

  const placeholder = createMemo(() => {
    switch (props.field) {
      case "name":
        return "Name used in prompt context";
      case "work":
        return "Role, team, domain, or responsibilities";
      case "instructions":
        return "Behavior instructions the agent should follow";
      case "details":
        return "Personal/context details the agent should remember";
    }
  });

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (props.field === "name") {
      syncActions.setConfig({ userName: trimmed });
      props.onDismiss();
      return;
    }

    syncActions.setConfig({
      userProfile: {
        [props.field]: trimmed,
      },
    });
    props.onDismiss();
  };

  const currentValue = createMemo(() => {
    if (props.field === "name") return syncState.userName;
    return syncState.userProfile[props.field] ?? "";
  });

  return (
    <DialogPrompt
      title={title()}
      placeholder={placeholder()}
      value={currentValue()}
      onDismiss={props.onDismiss}
      onSubmit={handleSubmit}
    />
  );
}
