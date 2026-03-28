import {
  Ionicons,
  MaterialCommunityIcons,
  MaterialIcons,
} from "@expo/vector-icons";
import type { TextStyle, StyleProp } from "react-native";

type SFSymbolProps = {
  name: string;
  size?: number;
  color: string;
  style?: StyleProp<TextStyle>;
};

const ICON_MAP = {
  "arrow.clockwise": { family: "material", name: "autorenew" },
  "arrow.left.arrow.right": { family: "material", name: "swap-horiz" },
  "bolt.fill": { family: "material", name: "bolt" },
  "brain.head.profile": { family: "community", name: "brain" },
  "bubble.left.and.bubble.right.fill": { family: "material", name: "forum" },
  "bubble.left.and.exclamationmark.bubble.right.fill": { family: "community", name: "message-alert" },
  "camera.fill": { family: "material", name: "photo-camera" },
  "chart.bar": { family: "material", name: "bar-chart" },
  "checkmark.shield.fill": { family: "community", name: "shield-check" },
  "chevron.down": { family: "material", name: "keyboard-arrow-down" },
  "chevron.right": { family: "material", name: "keyboard-arrow-right" },
  "clock": { family: "material", name: "schedule" },
  "desktopcomputer": { family: "material", name: "desktop-mac" },
  "desktopcomputer.and.arrow.down": { family: "community", name: "monitor-arrow-down" },
  "desktopcomputer.slash": { family: "community", name: "monitor-off" },
  "doc.text": { family: "material", name: "description" },
  "ellipsis": { family: "material", name: "more-horiz" },
  "ellipsis.message.fill": { family: "community", name: "message-processing" },
  "exclamationmark.bubble.fill": { family: "community", name: "message-alert" },
  "exclamationmark.triangle.fill": { family: "material", name: "warning-amber" },
  "externaldrive.badge.timemachine": { family: "community", name: "backup-restore" },
  "folder": { family: "material", name: "folder" },
  "gearshape.2": { family: "material", name: "settings" },
  "iphone.and.arrow.forward": { family: "community", name: "cellphone-arrow-right" },
  "key.fill": { family: "community", name: "key-variant" },
  "lock.shield.fill": { family: "community", name: "shield-lock" },
  "network": { family: "community", name: "lan" },
  "person.crop.circle.badge.checkmark": { family: "community", name: "account-check" },
  "puzzlepiece.extension": { family: "community", name: "puzzle" },
  "qrcode": { family: "material", name: "qr-code" },
  "qrcode.viewfinder": { family: "material", name: "qr-code-scanner" },
  "slider.horizontal.3": { family: "material", name: "tune" },
  "sparkles": { family: "material", name: "auto-awesome" },
  "square.grid.2x2": { family: "material", name: "grid-view" },
  "touchid": { family: "material", name: "fingerprint" },
  "wifi": { family: "ionicons", name: "wifi" },
  "xmark": { family: "material", name: "close" },
} as const satisfies Record<string, { family: "community" | "ionicons" | "material"; name: string }>;

export function SFSymbol({ name, size = 20, color, style }: SFSymbolProps) {
  const icon = ICON_MAP[name as keyof typeof ICON_MAP] ?? {
    family: "material" as const,
    name: "radio-button-unchecked",
  };

  if (icon.family === "community") {
    return (
      <MaterialCommunityIcons
        name={icon.name as keyof typeof MaterialCommunityIcons.glyphMap}
        size={size}
        color={color}
        style={style}
      />
    );
  }

  if (icon.family === "ionicons") {
    return (
      <Ionicons
        name={icon.name as keyof typeof Ionicons.glyphMap}
        size={size}
        color={color}
        style={style}
      />
    );
  }

  return (
    <MaterialIcons
      name={icon.name as keyof typeof MaterialIcons.glyphMap}
      size={size}
      color={color}
      style={style}
    />
  );
}
