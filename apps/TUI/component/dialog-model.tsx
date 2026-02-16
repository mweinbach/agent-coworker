import { createMemo } from "solid-js";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useLocal } from "../context/local";
import { useSyncActions, useSyncState } from "../context/sync";

export function openModelPicker(dialog: ReturnType<typeof useDialog>, providerFilter?: string) {
  dialog.push(
    () => <ModelPickerDialog onDismiss={() => dialog.pop()} providerFilter={providerFilter} />,
    () => {}
  );
}

function ModelPickerDialog(props: { onDismiss: () => void; providerFilter?: string }) {
  const local = useLocal();
  const syncActions = useSyncActions();
  const syncState = useSyncState();
  const dialog = useDialog();

  const items = createMemo((): SelectItem[] => {
    const choices = local
      .modelChoices()
      .filter((choice) => !props.providerFilter || choice.provider === props.providerFilter);

    const out = choices.map((choice) => ({
      label: choice.model,
      value: `${choice.provider}/${choice.model}`,
      description: choice.provider,
      category: choice.provider,
    }));

    if (props.providerFilter && !syncState.providerConnected.includes(props.providerFilter)) {
      out.unshift({
        label: "Connect provider first",
        value: "__connect_provider__",
        description: props.providerFilter,
        category: "Setup",
      });
    }

    return out;
  });

  const handleSelect = (item: SelectItem) => {
    if (item.value === "__connect_provider__") {
      import("./dialog-provider").then(({ openProviderDialog }) => openProviderDialog(dialog));
      props.onDismiss();
      return;
    }
    const [provider, ...modelParts] = item.value.split("/");
    const model = modelParts.join("/");
    syncActions.setModel(provider!, model);
    props.onDismiss();
  };

  return (
    <DialogSelect
      items={items()}
      onSelect={handleSelect}
      onDismiss={props.onDismiss}
      title="Switch Model"
      placeholder="Search models..."
    />
  );
}
