import { createMemo, createSignal } from "solid-js";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useLocal } from "../context/local";
import { useSyncActions } from "../context/sync";

export function openProviderDialog(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ProviderDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function ProviderDialog(props: { onDismiss: () => void }) {
  const local = useLocal();
  const syncActions = useSyncActions();

  const items = createMemo((): SelectItem[] => {
    return local.providerNames().map((name) => ({
      label: name,
      value: name,
      description: "Connect provider",
    }));
  });

  const handleSelect = (item: SelectItem) => {
    syncActions.connectProvider(item.value);
    props.onDismiss();
  };

  return (
    <DialogSelect
      items={items()}
      onSelect={handleSelect}
      onDismiss={props.onDismiss}
      title="Connect Provider"
      placeholder="Select a provider..."
    />
  );
}
