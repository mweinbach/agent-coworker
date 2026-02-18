import { useEffect, useState } from "react";

import { getPlatform, windowClose, windowMaximize, windowMinimize } from "../lib/desktopCommands";

export function TitleBar() {
  const [platform, setPlatform] = useState<string>("");

  useEffect(() => {
    void getPlatform().then(setPlatform);
  }, []);

  if (platform === "darwin") {
    return (
      <div className="titleBar titleBarMac">
        <div className="titleBarTrafficLights" />
        <div className="titleBarCenter">
          <span className="titleBarTitle">Cowork</span>
        </div>
      </div>
    );
  }

  return (
    <div className="titleBar titleBarWindows">
      <div className="titleBarLeft">
        <span className="titleBarTitle">Cowork</span>
      </div>
      <div className="titleBarControls">
        <button className="titleBarButton" type="button" onClick={() => void windowMinimize()} title="Minimize">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1" y="5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button className="titleBarButton" type="button" onClick={() => void windowMaximize()} title="Maximize">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        </button>
        <button className="titleBarButton titleBarButtonClose" type="button" onClick={() => void windowClose()} title="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
