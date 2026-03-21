import type { WindowChromeModule } from "./types";

const linuxWindowChrome: WindowChromeModule = {
  getBrowserWindowOptions() {
    return {};
  },
};

export default linuxWindowChrome;
