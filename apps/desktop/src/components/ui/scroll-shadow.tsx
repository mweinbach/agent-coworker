import * as React from "react";
import { ScrollShadow as HeroScrollShadow } from "@heroui/react";

type ScrollShadowProps = React.ComponentProps<typeof HeroScrollShadow>;

function ScrollShadow(props: ScrollShadowProps) {
  return <HeroScrollShadow {...props} />;
}

export { ScrollShadow };
