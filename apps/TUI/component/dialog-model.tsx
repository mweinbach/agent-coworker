import { createMemo } from "solid-js";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useLocal } from "../context/local";
import { useSyncActions, useSyncState } from "../context/sync";

export function openModelPicker(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ModelPickerDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function ModelPickerDialog(props: { onDismiss: () => void }) {
  const local = useLocal();
  const syncActions = useSyncActions();
  const syncState = useSyncState();

  const items = createMemo((): SelectItem[] => {
    return local.modelChoices().map((choice) => ({
      label: choice.model,
      value: `${choice.provider}/${choice.model}`,
      description: choice.provider,
      category: choice.provider,
    }));
  });

  const handleSelect = (item: SelectItem) => {
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
