import { createMemo } from "solid-js";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useThemeContext, THEMES } from "../context/theme";

export function openThemePicker(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <ThemePickerDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function ThemePickerDialog(props: { onDismiss: () => void }) {
  const themeCtx = useThemeContext();

  const items = createMemo((): SelectItem[] => {
    return Object.entries(THEMES).map(([key, def]) => ({
      label: def.name,
      value: key,
      description: def.appearance,
    }));
  });

  const handleSelect = (item: SelectItem) => {
    themeCtx.setTheme(item.value);
    props.onDismiss();
  };

  return (
    <DialogSelect
      items={items()}
      onSelect={handleSelect}
      onDismiss={props.onDismiss}
      title="Switch Theme"
      placeholder="Search themes..."
    />
  );
}
