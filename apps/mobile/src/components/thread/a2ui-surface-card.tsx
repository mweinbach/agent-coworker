import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";

import type { SessionFeedItem } from "@/features/cowork/protocolTypes";
import { useAppTheme } from "@/theme/use-app-theme";
import {
  isBasicCatalogId,
  isSupportedBasicComponentType,
} from "../../../../../src/shared/a2ui/component";
import {
  resolveDynamicBoolean,
  resolveDynamicString,
  stringifyDynamic,
} from "../../../../../src/shared/a2ui/expressions";
import { resolveDynamicWithFunctions } from "../../../../../src/shared/a2ui/functions";

type UiSurfaceItem = Extract<SessionFeedItem, { kind: "ui_surface" }>;

type A2uiSurfaceCardProps = {
  item: UiSurfaceItem;
};

type ComponentNode = {
  id?: unknown;
  type?: unknown;
  props?: Record<string, unknown>;
  children?: readonly unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerce(value: unknown): ComponentNode | null {
  return isRecord(value) ? (value as ComponentNode) : null;
}

function childrenOf(node: ComponentNode): ComponentNode[] {
  if (!Array.isArray(node.children)) return [];
  return node.children.map(coerce).filter((c): c is ComponentNode => c !== null);
}

function readText(
  props: Record<string, unknown> | undefined,
  model: unknown,
  ...keys: string[]
): string {
  if (!props) return "";
  for (const key of keys) {
    if (key in props) {
      return stringifyDynamic(resolveDynamicWithFunctions(props[key], model));
    }
  }
  return "";
}

const MAX_DEPTH = 24;

export function A2uiSurfaceCard({ item }: A2uiSurfaceCardProps) {
  const theme = useAppTheme();
  const unsupported = !isBasicCatalogId(item.catalogId);
  const root = coerce(item.root);

  if (item.deleted) {
    return (
      <View
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: theme.borderMuted,
          backgroundColor: theme.surfaceMuted,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 4,
        }}
      >
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Generative UI
        </Text>
        <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
          Surface {item.surfaceId} was deleted.
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        borderRadius: 22,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <Text
        selectable
        style={{
          color: theme.textSecondary,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Generative UI · {item.surfaceId}
      </Text>
      {unsupported ? (
        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
          Unsupported catalog: {item.catalogId}
        </Text>
      ) : null}
      {root ? (
        <RenderNode node={root} model={item.dataModel} depth={0} />
      ) : (
        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Empty surface.</Text>
      )}
    </View>
  );
}

function RenderNode({
  node,
  model,
  depth,
}: {
  node: ComponentNode;
  model: unknown;
  depth: number;
}) {
  const theme = useAppTheme();
  if (depth > MAX_DEPTH) {
    return <Text style={{ color: theme.danger, fontSize: 11 }}>Max depth reached</Text>;
  }
  const rawType = node.type;
  if (typeof rawType !== "string" || !isSupportedBasicComponentType(rawType)) {
    return (
      <Text style={{ color: theme.textSecondary, fontSize: 11 }}>
        Unrendered component{typeof rawType === "string" ? `: ${rawType}` : ""}
      </Text>
    );
  }

  const props = isRecord(node.props) ? node.props : undefined;
  const children = childrenOf(node).map((child, index) => (
    <RenderNode
      key={typeof child.id === "string" ? child.id : `${rawType}-${index}`}
      node={child}
      model={model}
      depth={depth + 1}
    />
  ));

  switch (rawType) {
    case "Text":
    case "Paragraph":
      return (
        <Text selectable style={{ color: theme.text, fontSize: 14, lineHeight: 20 }}>
          {readText(props, model, "text", "value")}
        </Text>
      );
    case "Heading": {
      const level = typeof props?.level === "number" ? props.level : 2;
      const fontSize = level === 1 ? 20 : level === 2 ? 17 : level === 3 ? 15 : 14;
      return (
        <Text
          selectable
          style={{
            color: theme.text,
            fontSize,
            fontWeight: "700",
            letterSpacing: -0.2,
          }}
        >
          {readText(props, model, "text", "value")}
        </Text>
      );
    }
    case "Column":
      return <View style={{ gap: 8, flexDirection: "column" }}>{children}</View>;
    case "Row":
      return <View style={{ gap: 8, flexDirection: "row", flexWrap: "wrap" }}>{children}</View>;
    case "Stack":
      return <View style={{ position: "relative" }}>{children}</View>;
    case "Card":
      return (
        <View
          style={{
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.borderMuted,
            padding: 10,
            gap: 6,
          }}
        >
          {children}
        </View>
      );
    case "Divider":
      return (
        <View
          style={{
            height: 1,
            backgroundColor: theme.border,
            marginVertical: 2,
          }}
        />
      );
    case "Spacer":
      return <View style={{ height: 12 }} />;
    case "Badge": {
      const tone = typeof props?.tone === "string" ? props.tone.toLowerCase() : "default";
      const toneColor =
        tone === "success"
          ? theme.primary
          : tone === "warning"
            ? theme.danger
            : tone === "danger" || tone === "error"
              ? theme.danger
              : theme.textSecondary;
      return (
        <View
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: toneColor,
          }}
        >
          <Text style={{ color: toneColor, fontSize: 11, fontWeight: "600" }}>
            {readText(props, model, "text", "label")}
          </Text>
        </View>
      );
    }
    case "Link": {
      const text = readText(props, model, "text", "label");
      const href = props?.href ?? props?.url;
      const hrefStr = typeof href === "string" ? href : resolveDynamicString(href, model);
      const safeHref = /^https?:\/\//i.test(hrefStr) ? hrefStr : null;
      return (
        <Pressable
          onPress={() => {
            if (safeHref) Linking.openURL(safeHref);
          }}
          disabled={!safeHref}
        >
          <Text
            style={{
              color: safeHref ? theme.primary : theme.textSecondary,
              textDecorationLine: "underline",
              fontSize: 14,
            }}
          >
            {text || hrefStr || "link"}
          </Text>
        </Pressable>
      );
    }
    case "Button": {
      const text = readText(props, model, "text", "label");
      return (
        <View
          style={{
            alignSelf: "flex-start",
            backgroundColor: theme.primaryMuted,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 8,
            opacity: 0.7,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>
            {text || "Button"}
          </Text>
        </View>
      );
    }
    case "TextField":
    case "TextArea": {
      const label = readText(props, model, "label");
      const value = readText(props, model, "value", "defaultValue", "initialValue");
      const placeholder = readText(props, model, "placeholder", "hint");
      return (
        <View style={{ gap: 4 }}>
          {label ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "600" }}>
              {label}
            </Text>
          ) : null}
          <View
            style={{
              borderWidth: 1,
              borderColor: theme.borderMuted,
              borderRadius: 8,
              backgroundColor: theme.surfaceMuted,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: value ? theme.text : theme.textSecondary, fontSize: 13 }}>
              {value || placeholder || " "}
            </Text>
          </View>
        </View>
      );
    }
    case "Checkbox": {
      const label = readText(props, model, "label", "text");
      const checked = resolveDynamicBoolean(props?.value ?? props?.checked, model);
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: checked ? theme.primary : "transparent",
            }}
          />
          <Text style={{ color: theme.text, fontSize: 13 }}>{label}</Text>
        </View>
      );
    }
    case "Select": {
      const label = readText(props, model, "label");
      const current = readText(props, model, "value", "defaultValue");
      return (
        <View style={{ gap: 4 }}>
          {label ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "600" }}>
              {label}
            </Text>
          ) : null}
          <View
            style={{
              borderWidth: 1,
              borderColor: theme.borderMuted,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 13 }}>{current || "(select)"}</Text>
          </View>
        </View>
      );
    }
    case "ProgressBar": {
      const raw = resolveDynamicWithFunctions(props?.value, model);
      const numeric = typeof raw === "number" ? raw : Number(raw);
      const rawMax = resolveDynamicWithFunctions(props?.max, model);
      const max = typeof rawMax === "number" && rawMax > 0 ? rawMax : 100;
      const pct = Number.isFinite(numeric) ? Math.max(0, Math.min(100, (numeric / max) * 100)) : 0;
      return (
        <View
          style={{
            height: 6,
            borderRadius: 999,
            backgroundColor: theme.surfaceMuted,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              width: `${pct}%`,
              height: "100%",
              backgroundColor: theme.primary,
            }}
          />
        </View>
      );
    }
    case "Image":
      return (
        <View
          style={{
            height: 120,
            borderRadius: 10,
            backgroundColor: theme.surfaceMuted,
            borderWidth: 1,
            borderColor: theme.borderMuted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: theme.textSecondary, fontSize: 11 }}>image</Text>
        </View>
      );
    case "List":
      return (
        <View style={{ gap: 4 }}>
          {children.map((child, i) => (
            <View key={`li-${i}`} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>•</Text>
              <View style={{ flex: 1 }}>{child}</View>
            </View>
          ))}
        </View>
      );
    case "Table": {
      const columnsRaw = resolveDynamicWithFunctions(props?.columns, model);
      const rowsRaw = resolveDynamicWithFunctions(props?.rows, model);
      const columns = Array.isArray(columnsRaw)
        ? columnsRaw.flatMap((col) => {
            if (typeof col === "string") return [{ key: col, label: col }];
            if (isRecord(col)) {
              const key =
                typeof col.key === "string"
                  ? col.key
                  : typeof col.id === "string"
                    ? col.id
                    : typeof col.field === "string"
                      ? col.field
                      : null;
              if (!key) return [];
              const label =
                typeof col.label === "string"
                  ? col.label
                  : typeof col.title === "string"
                    ? col.title
                    : key;
              return [{ key, label }];
            }
            return [];
          })
        : [];
      const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
      return (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {columns.map((col) => (
              <Text
                key={`th-${col.key}`}
                style={{
                  flex: 1,
                  color: theme.textSecondary,
                  fontSize: 10,
                  fontWeight: "700",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                {col.label}
              </Text>
            ))}
          </View>
          {rows.map((row, rowIdx) => (
            <View key={`tr-${rowIdx}`} style={{ flexDirection: "row", gap: 10 }}>
              {columns.map((col) => (
                <Text
                  key={`td-${rowIdx}-${col.key}`}
                  style={{ flex: 1, color: theme.text, fontSize: 12 }}
                >
                  {isRecord(row) ? stringifyDynamic((row as Record<string, unknown>)[col.key]) : ""}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    }
    default:
      return null;
  }
}
