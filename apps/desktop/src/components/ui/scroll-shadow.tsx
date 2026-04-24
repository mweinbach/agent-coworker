import { ScrollShadow as HeroScrollShadow } from "@heroui/react";
import type * as React from "react";

type ScrollShadowProps = React.ComponentProps<typeof HeroScrollShadow>;

function ScrollShadow(props: ScrollShadowProps) {
  return <HeroScrollShadow {...props} />;
}

export { ScrollShadow };
