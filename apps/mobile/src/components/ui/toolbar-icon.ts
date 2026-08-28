import type { ImageSourcePropType } from "react-native";

const androidIcons = {
  ellipsis: require("../../../assets/toolbar/more.xml"),
  "square.and.pencil": require("../../../assets/toolbar/compose.xml"),
  "xmark.circle.fill": require("../../../assets/toolbar/stop.xml"),
  "iphone.and.arrow.forward": require("../../../assets/toolbar/remote-access.xml"),
  "bubble.left.fill": require("../../../assets/toolbar/chat.xml"),
  "folder.fill": require("../../../assets/toolbar/folder.xml"),
} satisfies Record<string, ImageSourcePropType>;

type ToolbarIconName = keyof typeof androidIcons;

export function toolbarIcon(name: ToolbarIconName): ToolbarIconName | ImageSourcePropType {
  return process.env.EXPO_OS === "android" ? androidIcons[name] : name;
}
