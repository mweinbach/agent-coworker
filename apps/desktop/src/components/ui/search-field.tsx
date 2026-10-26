import { SearchField as GlisseSearchField } from "glisse";
import type * as React from "react";

import { cn } from "@/lib/utils";

type SearchFieldProps = React.ComponentProps<typeof GlisseSearchField>;

/**
 * Liquid Glass search capsule (glisse): magnifier, placeholder, and a clear
 * button. Drive it with `value` + `onValueChange`; the clear button reports
 * through `onValueChange`, not `onChange`.
 */
function SearchField({ className, ...props }: SearchFieldProps) {
  return (
    <GlisseSearchField
      data-slot="search-field"
      className={cn("app-glass-search", className)}
      {...props}
    />
  );
}

export { SearchField };
