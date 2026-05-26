import { Appearance, type ColorSchemeName } from "react-native";

export function resolveColorScheme(
  colorScheme: ColorSchemeName | null | undefined,
): "light" | "dark" {
  if (colorScheme === "dark" || colorScheme === "light") {
    return colorScheme;
  }

  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}
