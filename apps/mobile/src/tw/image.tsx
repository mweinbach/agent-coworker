import { Image as RNImage } from "expo-image";
import type React from "react";
import { StyleSheet } from "react-native";
import { useCssElement } from "react-native-css";
import Animated from "react-native-reanimated";

const AnimatedExpoImage = Animated.createAnimatedComponent(RNImage);
type CssElementComponent = Parameters<typeof useCssElement>[0];
type CssElementProps = Parameters<typeof useCssElement>[1];

function cssComponent<T>(component: T): CssElementComponent {
  return component as unknown as CssElementComponent;
}

function cssProps<T>(props: T): CssElementProps {
  return props as unknown as CssElementProps;
}

export type ImageProps = React.ComponentProps<typeof CSSImage>;

function CSSImage(props: React.ComponentProps<typeof AnimatedExpoImage>) {
  // @ts-expect-error: Remap objectFit style to contentFit property
  const { objectFit, objectPosition, ...style } = StyleSheet.flatten(props.style) || {};

  return (
    <AnimatedExpoImage
      contentFit={objectFit}
      contentPosition={objectPosition}
      {...props}
      source={typeof props.source === "string" ? { uri: props.source } : props.source}
      // @ts-expect-error: Style is remapped above
      style={style}
    />
  );
}

export const Image = (props: React.ComponentProps<typeof CSSImage> & { className?: string }) => {
  return useCssElement(cssComponent(CSSImage), cssProps(props), { className: "style" });
};

Image.displayName = "CSS(Image)";
