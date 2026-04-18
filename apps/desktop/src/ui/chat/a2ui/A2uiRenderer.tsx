import { Fragment, useState } from "react";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../../lib/utils";
import {
  formatString,
  resolveDynamic,
  resolveDynamicBoolean,
  resolveDynamicString,
  stringifyDynamic,
} from "../../../../../../src/shared/a2ui/expressions";
import { resolveDynamicWithFunctions } from "../../../../../../src/shared/a2ui/functions";
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

export type A2uiActionDispatcher = (opts: {
  componentId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}) => void | Promise<void>;

export type A2uiRendererProps = {
  root: A2uiRenderableComponent | null;
  dataModel: unknown;
  /** Whether interactive controls are wired up. Defaults to true when `onAction` is provided. */
  interactive?: boolean;
  /** Dispatcher invoked when a Button / TextField / Checkbox emits an action. */
  onAction?: A2uiActionDispatcher;
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
      const resolved = resolveDynamicWithFunctions(props[key], model);
      return stringifyDynamic(resolved);
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
  const resolved = resolveDynamicWithFunctions(props[key], model);
  if (typeof resolved === "boolean") return resolved;
  return resolveDynamicBoolean(resolved, model);
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
  onAction?: A2uiActionDispatcher;
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
            level === 1 && "text-[22px] leading-7",
            level === 2 && "text-lg leading-6",
            level === 3 && "text-[15px] leading-6",
            level >= 4 && "text-sm leading-5",
          )}
        >
          {text}
        </HeadingTag>
      );
    }

    case "Divider":
      return <hr className="my-1 border-t border-border/25" />;

    case "Spacer":
      return <div aria-hidden className="h-3 w-full" />;

    case "Column":
      return (
        <div
          className={cn(
            "flex flex-col gap-3",
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
            "flex flex-row flex-wrap gap-2.5",
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

    case "Card": {
      // When a Card is at the top of the surface tree (depth === 0), the
      // component that hosts the renderer (e.g. A2uiInlineCard, the surface
      // dock, the popout dialog) is already supplying the visible card chrome
      // — border, background, shadow, padding. Nesting a second card inside
      // that host produces a "card on card" look. Render root-level cards as
      // a plain column so the host's chrome is the only card surface.
      const isRootCard = context.depth === 0;
      const cardChildren = (
        <div
          className={cn(
            "flex flex-col",
            isRootCard ? "gap-4" : "gap-2.5",
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
      if (isRootCard) {
        return cardChildren;
      }
      return (
        <div className="rounded-xl border border-border/25 bg-muted/[0.02] p-4">
          {cardChildren}
        </div>
      );
    }

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
      const componentId = typeof component.id === "string" ? component.id : "";
      const canClick = context.interactive && Boolean(context.onAction) && componentId.length > 0;
      const eventType = typeof props?.eventType === "string" ? props.eventType : "click";
      const tooltip = canClick
        ? undefined
        : "Interactions are not wired up for this surface.";
      const variant = typeof props?.variant === "string" ? props.variant.toLowerCase() : "primary";
      const buttonClass = variant === "secondary" || variant === "ghost" || variant === "outline"
        ? "border-border/60 bg-background/70 text-foreground hover:bg-muted/40"
        : "border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90";
      return (
        <button
          type="button"
          disabled={!canClick}
          title={tooltip}
          className={cn(
            "inline-flex h-9 items-center justify-center rounded-lg border px-3.5 text-[13px] font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-70",
            buttonClass,
          )}
          onClick={(event) => {
            event.preventDefault();
            if (!canClick || !context.onAction) return;
            void context.onAction({ componentId, eventType });
          }}
        >
          {text || "Button"}
        </button>
      );
    }

    case "TextField": {
      const placeholder = resolveText(props, context.dataModel, "placeholder", "hint");
      const label = resolveText(props, context.dataModel, "label");
      const defaultValue = resolveText(props, context.dataModel, "value", "defaultValue", "initialValue");
      const componentId = typeof component.id === "string" ? component.id : "";
      const canSubmit = context.interactive && Boolean(context.onAction) && componentId.length > 0;
      return (
        <ControlledTextField
          label={label}
          placeholder={placeholder}
          defaultValue={defaultValue}
          {...(canSubmit
            ? {
                onSubmit: (value) => {
                  if (!context.onAction) return;
                  void context.onAction({ componentId, eventType: "submit", payload: { value } });
                },
                onBlurSubmit: (value) => {
                  if (!context.onAction) return;
                  void context.onAction({ componentId, eventType: "change", payload: { value } });
                },
              }
            : {})}
        />
      );
    }

    case "Checkbox": {
      const label = resolveText(props, context.dataModel, "label", "text");
      const initialValue = resolveBooleanProp(props, context.dataModel, "value")
        || resolveBooleanProp(props, context.dataModel, "checked")
        || resolveBooleanProp(props, context.dataModel, "defaultChecked");
      const componentId = typeof component.id === "string" ? component.id : "";
      const canChange = context.interactive && Boolean(context.onAction) && componentId.length > 0;
      return (
        <ControlledCheckbox
          label={label}
          initialValue={initialValue}
          {...(canChange
            ? {
                onChange: (value) => {
                  if (!context.onAction) return;
                  void context.onAction({ componentId, eventType: "change", payload: { value } });
                },
              }
            : {})}
        />
      );
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

    case "TextArea": {
      const placeholder = resolveText(props, context.dataModel, "placeholder", "hint");
      const label = resolveText(props, context.dataModel, "label");
      const defaultValue = resolveText(props, context.dataModel, "value", "defaultValue", "initialValue");
      const componentId = typeof component.id === "string" ? component.id : "";
      const rowsRaw = props?.rows;
      const rows = typeof rowsRaw === "number" && rowsRaw > 0 ? Math.min(Math.max(Math.floor(rowsRaw), 2), 20) : 4;
      const canSubmit = context.interactive && Boolean(context.onAction) && componentId.length > 0;
      return (
        <ControlledTextArea
          label={label}
          placeholder={placeholder}
          defaultValue={defaultValue}
          rows={rows}
          {...(canSubmit
            ? {
                onBlurSubmit: (value) => {
                  if (!context.onAction) return;
                  void context.onAction({ componentId, eventType: "change", payload: { value } });
                },
              }
            : {})}
        />
      );
    }

    case "Select": {
      const label = resolveText(props, context.dataModel, "label");
      const placeholder = resolveText(props, context.dataModel, "placeholder");
      const componentId = typeof component.id === "string" ? component.id : "";
      const canChange = context.interactive && Boolean(context.onAction) && componentId.length > 0;
      const rawOptions = resolveDynamicWithFunctions(props?.options, context.dataModel);
      const options = Array.isArray(rawOptions)
        ? rawOptions.flatMap((entry): Array<{ label: string; value: string }> => {
            if (typeof entry === "string" || typeof entry === "number") {
              return [{ label: String(entry), value: String(entry) }];
            }
            if (entry && typeof entry === "object") {
              const rec = entry as Record<string, unknown>;
              const value = rec.value ?? rec.id ?? rec.key ?? rec.label;
              const lbl = rec.label ?? rec.text ?? rec.title ?? value;
              if (value === undefined) return [];
              return [{ label: String(lbl ?? value), value: String(value) }];
            }
            return [];
          })
        : [];
      const defaultValue = resolveDynamicString(props?.value ?? props?.defaultValue, context.dataModel)
        || (options[0]?.value ?? "");
      return (
        <ControlledSelect
          label={label}
          placeholder={placeholder}
          defaultValue={defaultValue}
          options={options}
          {...(canChange
            ? {
                onChange: (value) => {
                  if (!context.onAction) return;
                  void context.onAction({ componentId, eventType: "change", payload: { value } });
                },
              }
            : {})}
        />
      );
    }

    case "Link": {
      const text = resolveText(props, context.dataModel, "text", "label");
      const href = resolveImageSrc(props?.href ?? props?.url, context.dataModel);
      if (!href) {
        return <span className="text-sm text-muted-foreground underline-offset-2">{text || "link"}</span>;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="text-sm text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {text || href}
        </a>
      );
    }

    case "ProgressBar": {
      const value = clampProgressValue(resolveDynamicWithFunctions(props?.value, context.dataModel));
      const max = (() => {
        const raw = resolveDynamicWithFunctions(props?.max, context.dataModel);
        return typeof raw === "number" && raw > 0 ? raw : 100;
      })();
      const label = resolveText(props, context.dataModel, "label");
      const pct = Math.max(0, Math.min(100, (value / max) * 100));
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : <span />}
            <span className="tabular-nums text-[11px] font-semibold text-foreground/80">{Math.round(pct)}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary/85 to-primary transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` } as CSSProperties}
            />
          </div>
        </div>
      );
    }

    case "Badge": {
      const text = resolveText(props, context.dataModel, "text", "label");
      const tone = typeof props?.tone === "string" ? props.tone.toLowerCase() : "default";
      const toneClass = tone === "success"
        ? "border-success/30 bg-success/10 text-success"
        : tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : tone === "danger" || tone === "error"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : tone === "info" || tone === "primary"
              ? "border-primary/25 bg-primary/10 text-primary"
              : "border-border/50 bg-muted/50 text-muted-foreground";
      return (
        <span className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
          toneClass,
        )}>{text}</span>
      );
    }

    case "Table": {
      const columnsRaw = resolveDynamicWithFunctions(props?.columns, context.dataModel);
      const rowsRaw = resolveDynamicWithFunctions(props?.rows, context.dataModel);
      const columns = Array.isArray(columnsRaw)
        ? columnsRaw.flatMap((col): Array<{ key: string; label: string }> => {
            if (typeof col === "string") return [{ key: col, label: col }];
            if (col && typeof col === "object") {
              const rec = col as Record<string, unknown>;
              const key = typeof rec.key === "string" ? rec.key
                : typeof rec.id === "string" ? rec.id
                : typeof rec.field === "string" ? rec.field
                : null;
              if (!key) return [];
              const lbl = typeof rec.label === "string" ? rec.label
                : typeof rec.title === "string" ? rec.title
                : key;
              return [{ key, label: lbl }];
            }
            return [];
          })
        : [];
      const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
      if (columns.length === 0) {
        return <UnknownComponent component={component} context={childContext} reason="Table requires props.columns" />;
      }
      return (
        <div className="overflow-hidden overflow-x-auto rounded-xl border border-border/30 bg-gradient-to-b from-muted/[0.12] to-muted/[0.03] ring-1 ring-border/15 shadow-[var(--shadow-field)]">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border/35 bg-muted/20">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr
                  key={`row-${rowIndex}`}
                  className={cn(
                    "border-b border-border/[0.14] transition-colors last:border-b-0",
                    rowIndex % 2 === 1 && "bg-muted/[0.045]",
                    "hover:bg-muted/[0.09]",
                  )}
                >
                  {columns.map((col, colIndex) => (
                    <td
                      key={`cell-${rowIndex}-${col.key}`}
                      className={cn(
                        "px-4 py-3.5 align-top text-[13px] leading-relaxed text-foreground/88 sm:py-4",
                        colIndex === 0 && "font-medium text-foreground",
                      )}
                    >
                      <span className="block min-w-0 break-words">{tableCellRender(row, col.key)}</span>
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No rows.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      );
    }

    default:
      return <UnknownComponent component={component} context={childContext} reason={`unhandled type: ${rawType}`} />;
  }
}

function clampProgressValue(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function tableCellRender(row: unknown, key: string): ReactNode {
  if (!row || typeof row !== "object") return "";
  const rec = row as Record<string, unknown>;
  const value = rec[key];
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ControlledTextField({
  label,
  placeholder,
  defaultValue,
  onSubmit,
  onBlurSubmit,
}: {
  label: string;
  placeholder: string;
  defaultValue: string;
  onSubmit?: (value: string) => void;
  onBlurSubmit?: (value: string) => void;
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
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && onSubmit) {
            event.preventDefault();
            onSubmit(value);
          }
        }}
        onBlur={() => {
          if (onBlurSubmit && value !== defaultValue) {
            onBlurSubmit(value);
          }
        }}
        className="h-10 w-full rounded-lg border border-border/60 bg-background/70 px-3 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}

function ControlledTextArea({
  label,
  placeholder,
  defaultValue,
  rows,
  onBlurSubmit,
}: {
  label: string;
  placeholder: string;
  defaultValue: string;
  rows: number;
  onBlurSubmit?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputId = `a2ui-textarea-${useSafeId()}`;
  return (
    <label className="flex w-full flex-col gap-1 text-sm" htmlFor={inputId}>
      {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : null}
      <textarea
        id={inputId}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={() => {
          if (onBlurSubmit && value !== defaultValue) onBlurSubmit(value);
        }}
        className="w-full resize-y rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}

function ControlledSelect({
  label,
  placeholder,
  defaultValue,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  defaultValue: string;
  options: Array<{ label: string; value: string }>;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputId = `a2ui-select-${useSafeId()}`;
  const hasPlaceholder = placeholder && !options.some((option) => option.value === defaultValue);
  return (
    <label className="flex w-full flex-col gap-1 text-sm" htmlFor={inputId}>
      {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : null}
      <select
        id={inputId}
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setValue(next);
          onChange?.(next);
        }}
        className="h-10 w-full rounded-lg border border-border/60 bg-background/70 px-3 text-sm text-foreground shadow-none focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {hasPlaceholder ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function ControlledCheckbox({
  label,
  initialValue,
  onChange,
}: {
  label: string;
  initialValue: boolean;
  onChange?: (value: boolean) => void;
}) {
  const [checked, setChecked] = useState(initialValue);
  const inputId = `a2ui-checkbox-${useSafeId()}`;
  return (
    <label className="flex items-center gap-2 text-sm text-foreground" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setChecked(next);
          onChange?.(next);
        }}
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

export function A2uiRenderer({ root, dataModel, interactive, onAction }: A2uiRendererProps) {
  if (!root) {
    return (
      <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
        Surface has no root component yet.
      </div>
    );
  }

  const context: RenderContext = {
    dataModel,
    interactive: interactive ?? Boolean(onAction),
    ...(onAction ? { onAction } : {}),
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
