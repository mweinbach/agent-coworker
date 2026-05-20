import type { PropsWithChildren, ReactNode } from "react";
import { Text, View } from "@/tw";

type SectionCardProps = PropsWithChildren<{
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}>;

export function SectionCard({ title, description, action, children, className }: SectionCardProps) {
  return (
    <View
      className={`gap-[14px] rounded-[24px] border border-border-subtle bg-surface-card p-[18px] shadow-surface ${className || ""}`}
    >
      <View className="flex-row items-start justify-between gap-md">
        <View className="flex-1 gap-[6px]">
          <Text selectable className="text-text-primary text-[17px] font-bold tracking-[-0.2px]">
            {title}
          </Text>
          {description ? (
            <Text selectable className="text-text-secondary text-md leading-[20px]">
              {description}
            </Text>
          ) : null}
        </View>
        {action ? <View>{action}</View> : null}
      </View>
      <View className="gap-md">{children}</View>
    </View>
  );
}
