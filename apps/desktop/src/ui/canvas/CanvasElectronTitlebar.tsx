import { Loader2Icon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

const titlebarStyle = {
  height: "var(--platform-titlebar-height, 38px)",
  paddingLeft: "calc(var(--platform-left-native-reserve, 0px) + 12px)",
  paddingRight: "calc(var(--platform-right-native-reserve, 0px) + 12px)",
  WebkitAppRegion: "drag",
} as CSSProperties;

type CanvasElectronTitlebarProps = {
  leading: ReactNode;
  trailing?: ReactNode;
  isAgentBusy?: boolean;
};

export function CanvasElectronTitlebar({
  leading,
  trailing,
  isAgentBusy = false,
}: CanvasElectronTitlebarProps) {
  return (
    <div
      className="flex shrink-0 items-center justify-between border-b border-border/40 px-2.5 gap-2 select-none bg-transparent"
      style={titlebarStyle}
    >
      <div className="flex min-w-0 items-center gap-1.5 flex-1">
        {leading}
        {isAgentBusy ? (
          <Loader2Icon className="size-2.5 animate-spin text-primary shrink-0" />
        ) : null}
      </div>

      {trailing ? (
        <div
          className="flex items-center gap-1 shrink-0 flex-1 justify-end"
          style={noDragRegionStyle}
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
