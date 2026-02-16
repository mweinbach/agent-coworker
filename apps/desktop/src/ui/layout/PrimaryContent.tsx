import { ChatView } from "../ChatView";
import { SkillsView } from "../SkillsView";

interface PrimaryContentProps {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
  view: "chat" | "skills";
}

export function PrimaryContent({ init, ready, startupError, view }: PrimaryContentProps) {
  if (!ready) {
    return (
      <div className="hero">
        <div className="heroTitle">Starting…</div>
      </div>
    );
  }

  if (startupError) {
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

  return view === "skills" ? <SkillsView /> : <ChatView />;
}
