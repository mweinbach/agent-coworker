import { ChatView } from "../ChatView";
import { SkillsView } from "../SkillsView";

interface PrimaryContentProps {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
  view: "chat" | "skills";
}

type PrimaryContentVariant = "starting" | "error" | "chat" | "skills";

function resolveVariant({ ready, startupError, view }: Omit<PrimaryContentProps, "init">): PrimaryContentVariant {
  if (!ready) {
    return "starting";
  }
  if (startupError) {
    return "error";
  }
  return view === "skills" ? "skills" : "chat";
}

function StartingContent() {
  return (
    <div className="hero">
      <div className="heroTitle">Starting…</div>
    </div>
  );
}

function ErrorContent({ startupError, init }: { startupError: string; init: () => Promise<void> }) {
  return (
    <div className="hero">
      <div className="heroTitle">Recovered</div>
      <div className="heroSub">{startupError}</div>
      <button className="iconButton" type="button" onClick={() => void init()}>
        Retry
      </button>
    </div>
  );
}

export function PrimaryContent({ init, ready, startupError, view }: PrimaryContentProps) {
  const variant = resolveVariant({ ready, startupError, view });
  switch (variant) {
    case "starting":
      return <StartingContent />;
    case "error":
      return <ErrorContent startupError={startupError ?? "Startup error"} init={init} />;
    case "skills":
      return <SkillsView />;
    case "chat":
      return <ChatView />;
    default:
      return <ChatView />;
  }
}
