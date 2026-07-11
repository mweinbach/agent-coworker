import { Image } from "expo-image";
import type { ColorValue, ImageStyle, StyleProp } from "react-native";

type SFSymbolProps = {
  name: string;
  size?: number;
  color: ColorValue;
  style?: StyleProp<ImageStyle>;
};

function nativeSymbolSource(name: string): `sf:${string}` {
  return `sf:${name}`;
}

export function SFSymbol({ name, size = 20, color, style }: SFSymbolProps) {
  return (
    <Image
      accessibilityElementsHidden
      accessible={false}
      contentFit="contain"
      source={nativeSymbolSource(name)}
      style={[
        {
          width: size,
          height: size,
          color,
          fontSize: size,
        },
        style,
      ]}
    />
  );
}
