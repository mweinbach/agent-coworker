import { SettingsShell } from "../settings/SettingsShell";

interface SettingsContentProps {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
}

export function SettingsContent({ init, ready, startupError }: SettingsContentProps) {
  if (!ready) {
    return (
      <div className="hero">
        <div className="heroTitle">Starting…</div>
      </div>
    );
  }

  return (
    <>
      {startupError ? (
        <div className="startupErrorCard">
          <div>Running with fresh state due to an error.</div>
          <button className="iconButton mt-2" type="button" onClick={() => void init()}>
            Retry
          </button>
        </div>
      ) : null}
      <SettingsShell />
    </>
  );
}
