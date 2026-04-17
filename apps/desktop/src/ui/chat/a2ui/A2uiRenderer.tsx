import { Fragment, useState } from "react";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../../lib/utils";
import {
  formatString,
  resolveDynamic,
  resolveDynamicBoolean,
  resolveDynamicString,
} from "../../../../../../src/shared/a2ui/expressions";
import { isSupportedBasicComponentType } from "../../../../../../src/shared/a2ui/component";

/**
 * Permissive shape of an A2UI v0.9 component. We defensively introspect
 * unknown fields because envelopes come from an agent that may add new
 * catalog entries we don't yet render.
 */
export type A2uiRenderableComponent = {
  id?: unknown;
  type?: unknown;
  props?: Record<string, unknown>;
  children?: readonly unknown[];
  [key: string]: unknown;
};

export type A2uiRendererProps = {
  root: A2uiRenderableComponent | null;
  dataModel: unknown;
  /** Whether interactive controls should be rendered as disabled (phase 1 default). */
  interactive?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toComponent(value: unknown): A2uiRenderableComponent | null {
  return isRecord(value) ? (value as A2uiRenderableComponent) : null;
}

function resolveChildren(component: A2uiRenderableComponent): A2uiRenderableComponent[] {
  const children = component.children;
  if (!Array.isArray(children)) return [];
  return children.map(toComponent).filter((c): c is A2uiRenderableComponent => c !== null);
}

function resolveText(
  props: Record<string, unknown> | undefined,
  model: unknown,
  ...keys: string[]
): string {
  if (!props) return "";
  for (const key of keys) {
    if (key in props) {
      return resolveDynamicString(props[key], model);
    }
  }
  return "";
}

function resolveBooleanProp(
  props: Record<string, unknown> | undefined,
  model: unknown,
  key: string,
  fallback = false,
): boolean {
  if (!props || !(key in props)) return fallback;
  return resolveDynamicBoolean(props[key], model);
}

function resolveOptionalAlignmentClass(
  props: Record<string, unknown> | undefined,
  axis: "justify" | "items",
): string | null {
  if (!props) return null;
  const raw = axis === "justify" ? props.justify ?? props.alignX : props.align ?? props.alignY;
  if (typeof raw !== "string") return null;
  const normalized = raw.toLowerCase();
  const map = axis === "justify"
    ? {
        start: "justify-start",
        center: "justify-center",
        end: "justify-end",
        between: "justify-between",
        around: "justify-around",
        evenly: "justify-evenly",
      } as Record<string, string>
    : {
        start: "items-start",
        center: "items-center",
        end: "items-end",
        stretch: "items-stretch",
        baseline: "items-baseline",
      } as Record<string, string>;
  return map[normalized] ?? null;
}

function resolveImageSrc(rawValue: unknown, model: unknown): string | null {
  const value = resolveDynamicString(rawValue, model).trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "data:") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

type RenderContext = {
  dataModel: unknown;
  interactive: boolean;
  depth: number;
  path: string;
};

const MAX_RENDER_DEPTH = 32;

function RenderNode({ component, context }: { component: A2uiRenderableComponent; context: RenderContext }) {
  if (context.depth > MAX_RENDER_DEPTH) {
    return (
      <pre className="whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
        a2ui: max render depth exceeded at {context.path}
      </pre>
    );
  }

  const rawType = component.type;
  if (typeof rawType !== "string" || !rawType.trim()) {
    return <UnknownComponent component={component} context={context} reason="missing component type" />;
  }
  if (!isSupportedBasicComponentType(rawType)) {
    return <UnknownComponent component={component} context={context} reason={`unsupported type: ${rawType}`} />;
  }

  const props = isRecord(component.props) ? component.props : undefined;
  const children = resolveChildren(component);
  const childContext: RenderContext = {
    ...context,
    depth: context.depth + 1,
    path: component.id ? `${context.path}/${String(component.id)}` : context.path,
  };

  switch (rawType) {
    case "Text":
    case "Paragraph": {
      const text = resolveText(props, context.dataModel, "text", "value");
      return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{text}</p>;
    }

    case "Heading": {
      const text = resolveText(props, context.dataModel, "text", "value");
      const level = Math.min(Math.max(Number(props?.level ?? 2), 1), 6);
      const HeadingTag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
      return (
        <HeadingTag
          className={cn(
            "font-semibold tracking-tight text-foreground",
            level === 1 && "text-xl",
            level === 2 && "text-lg",
            level === 3 && "text-base",
            level >= 4 && "text-sm",
          )}
        >
          {text}
        </HeadingTag>
      );
    }

    case "Divider":
      return <hr className="my-1 border-t border-border/60" />;

    case "Spacer":
      return <div aria-hidden className="h-3 w-full" />;

    case "Column":
      return (
        <div
          className={cn(
            "flex flex-col gap-2",
            resolveOptionalAlignmentClass(props, "justify"),
            resolveOptionalAlignmentClass(props, "items"),
          )}
        >
          {children.map((child, index) => (
            <Fragment key={childKey(child, index)}>
              <RenderNode component={child} context={childContext} />
            </Fragment>
          ))}
        </div>
      );

    case "Row":
      return (
        <div
          className={cn(
            "flex flex-row flex-wrap gap-2",
            resolveOptionalAlignmentClass(props, "justify"),
            resolveOptionalAlignmentClass(props, "items") ?? "items-center",
          )}
        >
          {children.map((child, index) => (
            <Fragment key={childKey(child, index)}>
              <RenderNode component={child} context={childContext} />
            </Fragment>
          ))}
        </div>
      );

    case "Stack":
      return (
        <div className="relative">
          {children.map((child, index) => (
            <div key={childKey(child, index)} className="absolute inset-0">
              <RenderNode component={child} context={childContext} />
            </div>
          ))}
        </div>
      );

    case "Card":
      return (
        <div className="rounded-[10px] border border-border/50 bg-background/70 p-3 shadow-none">
          <div className="flex flex-col gap-2">
            {children.map((child, index) => (
              <Fragment key={childKey(child, index)}>
                <RenderNode component={child} context={childContext} />
              </Fragment>
            ))}
          </div>
        </div>
      );

    case "List": {
      const ordered = resolveBooleanProp(props, context.dataModel, "ordered");
      const ListTag = (ordered ? "ol" : "ul") as keyof React.JSX.IntrinsicElements;
      return (
        <ListTag className={cn("flex flex-col gap-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {children.map((child, index) => (
            <li key={childKey(child, index)}>
              <RenderNode component={child} context={childContext} />
            </li>
          ))}
        </ListTag>
      );
    }

    case "Button": {
      const text = resolveText(props, context.dataModel, "text", "label");
      const tooltip = context.interactive
        ? undefined
        : "Button interactions are not yet delivered back to the agent.";
      return (
        <button
          type="button"
          disabled
          title={tooltip}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground opacity-75"
        >
          {text || "Button"}
        </button>
      );
    }

    case "TextField": {
      const placeholder = resolveText(props, context.dataModel, "placeholder", "hint");
      const label = resolveText(props, context.dataModel, "label");
      const defaultValue = resolveText(props, context.dataModel, "value", "defaultValue", "initialValue");
      return <ControlledTextField label={label} placeholder={placeholder} defaultValue={defaultValue} />;
    }

    case "Checkbox": {
      const label = resolveText(props, context.dataModel, "label", "text");
      const initialValue = resolveBooleanProp(props, context.dataModel, "value")
        || resolveBooleanProp(props, context.dataModel, "checked")
        || resolveBooleanProp(props, context.dataModel, "defaultChecked");
      return <ControlledCheckbox label={label} initialValue={initialValue} />;
    }

    case "Image": {
      const src = resolveImageSrc(props?.src ?? props?.url, context.dataModel);
      const alt = resolveText(props, context.dataModel, "alt", "description");
      if (!src) {
        return (
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30 text-xs text-muted-foreground">
            (image source unavailable)
          </div>
        );
      }
      return (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ maxWidth: "100%", maxHeight: 320, objectFit: "contain" } as CSSProperties}
          className="rounded-md border border-border/40 bg-background/60"
        />
      );
    }

    default:
      return <UnknownComponent component={component} context={childContext} reason={`unhandled type: ${rawType}`} />;
  }
}

function ControlledTextField({
  label,
  placeholder,
  defaultValue,
}: {
  label: string;
  placeholder: string;
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputId = `a2ui-textfield-${useSafeId()}`;
  return (
    <label className="flex w-full flex-col gap-1 text-sm" htmlFor={inputId}>
      {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : null}
      <input
        id={inputId}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.currentTarget.value)}
        className="h-9 w-full rounded-md border border-border/60 bg-background/70 px-3 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}

function ControlledCheckbox({ label, initialValue }: { label: string; initialValue: boolean }) {
  const [checked, setChecked] = useState(initialValue);
  const inputId = `a2ui-checkbox-${useSafeId()}`;
  return (
    <label className="flex items-center gap-2 text-sm text-foreground" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(event) => setChecked(event.currentTarget.checked)}
        className="size-4 rounded border border-border/60 bg-background"
      />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

function useSafeId(): string {
  // React.useId is available but we need stable suffixes across branches.
  // Using React.useId directly requires importing, but to keep this file
  // self-contained we fall back to a simple ref.
  const [id] = useState(() => Math.random().toString(36).slice(2, 10));
  return id;
}

function UnknownComponent({
  component,
  context,
  reason,
}: {
  component: A2uiRenderableComponent;
  context: RenderContext;
  reason: string;
}): ReactNode {
  const typeName = typeof component.type === "string" ? component.type : String(component.type ?? "?");
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-2 text-xs">
      <div className="font-semibold text-muted-foreground">Unrendered component</div>
      <div className="text-muted-foreground">{reason}</div>
      <code className="mt-1 block whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
        {JSON.stringify({ id: component.id, type: typeName, at: context.path }, null, 2)}
      </code>
    </div>
  );
}

function childKey(child: A2uiRenderableComponent, index: number): string {
  const id = child.id;
  if (typeof id === "string" || typeof id === "number") return String(id);
  return `__idx_${index}`;
}

export function A2uiRenderer({ root, dataModel, interactive = false }: A2uiRendererProps) {
  if (!root) {
    return (
      <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
        Surface has no root component yet.
      </div>
    );
  }

  const context: RenderContext = {
    dataModel,
    interactive,
    depth: 0,
    path: typeof root.id === "string" ? root.id : "root",
  };
  return <RenderNode component={root} context={context} />;
}

// Re-exported helpers used by tests.
export const __internal = {
  formatString,
  resolveDynamic,
};
