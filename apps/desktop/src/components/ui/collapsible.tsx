import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as React from "react";

const Collapsible = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root> & {
    disabled?: boolean;
  }
>(function Collapsible({ disabled, ...props }, ref) {
  return <CollapsiblePrimitive.Root ref={ref} disabled={disabled} {...props} />;
});

Collapsible.displayName = "Collapsible";

const CollapsibleTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>
>(function CollapsibleTrigger(props, ref) {
  return <CollapsiblePrimitive.CollapsibleTrigger ref={ref} {...props} />;
});

CollapsibleTrigger.displayName = "CollapsibleTrigger";

const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(function CollapsibleContent(props, ref) {
  return <CollapsiblePrimitive.CollapsibleContent ref={ref} {...props} />;
});

CollapsibleContent.displayName = "CollapsibleContent";

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
