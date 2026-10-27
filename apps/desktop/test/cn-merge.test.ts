import { describe, expect, test } from "bun:test";
import { cn } from "../src/lib/utils";

describe("cn", () => {
  test("keeps the later app surface token when custom and standard background classes conflict", () => {
    expect(cn("app-hover-wash", "app-fill-subtle")).toBe("app-fill-subtle");
    expect(cn("app-fill-subtle", "bg-red-500")).toBe("bg-red-500");
    expect(cn("hover:app-hover-wash", "hover:app-fill-subtle")).toBe("hover:app-fill-subtle");
    expect(cn("app-fill-strong", "focus:app-hover-wash")).toBe(
      "app-fill-strong focus:app-hover-wash",
    );
  });

  test("collapses app border colors without dropping width or unrelated utilities", () => {
    expect(cn("px-2 app-border-subtle", "app-border-strong px-3")).toBe("app-border-strong px-3");
    expect(cn("border-red-500", "app-border-strong")).toBe("app-border-strong");
    expect(cn("app-border-default", "border-2")).toBe("app-border-default border-2");
    expect(cn("app-hover-wash app-border-subtle text-sm", "app-fill-strong")).toBe(
      "app-border-subtle text-sm app-fill-strong",
    );
  });
});
