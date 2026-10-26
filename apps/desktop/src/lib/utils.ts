import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "bg-color": ["app-hover-wash", "app-fill-subtle", "app-fill-strong"],
      "border-color": ["app-border-default", "app-border-subtle", "app-border-strong"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return customTwMerge(clsx(inputs));
}
