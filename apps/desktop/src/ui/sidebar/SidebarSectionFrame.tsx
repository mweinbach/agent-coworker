import { Reorder, useDragControls } from "framer-motion";
import type { ReactNode } from "react";
import { memo } from "react";
import type { SidebarSectionKey } from "../../app/types";
import { cn } from "../../lib/utils";

const SIDEBAR_SECTION_REORDER_LAYOUT_TRANSITION = {
  layout: {
    type: "spring" as const,
    stiffness: 420,
    damping: 36,
    mass: 0.9,
  },
};

type SidebarSectionFrameProps = {
  children: ReactNode;
  reorderEnabled: boolean;
  sectionKey: SidebarSectionKey;
};

export const SidebarSectionFrame = memo(function SidebarSectionFrame({
  children,
  reorderEnabled,
  sectionKey,
}: SidebarSectionFrameProps) {
  const controls = useDragControls();
  const className = cn("flex min-w-0 flex-col");

  if (!reorderEnabled) {
    return (
      <div className={className} data-sidebar-section={sectionKey}>
        {children}
      </div>
    );
  }

  return (
    <Reorder.Item
      as="div"
      className={className}
      data-sidebar-section={sectionKey}
      dragControls={controls}
      dragListener={false}
      layout="position"
      onPointerDownCapture={(event) => {
        if (event.button !== 0) {
          return;
        }
        const target = event.target as HTMLElement;
        if (!target.closest('[data-sidebar-section-drag-handle="true"]')) {
          return;
        }
        if (target.closest('[data-sidebar-section-action="true"]')) {
          return;
        }
        controls.start(event);
      }}
      transition={SIDEBAR_SECTION_REORDER_LAYOUT_TRANSITION}
      value={sectionKey}
    >
      {children}
    </Reorder.Item>
  );
});
