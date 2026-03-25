import { useEffect } from "react";
import type { PropsWithChildren } from "react";

import { addRemodexListener, getTransportState, listTrustedMacs } from "../../modules/remodex-secure-transport/src";
import { usePairingStore } from "../features/pairing/pairingStore";
import { useThreadStore } from "../features/cowork/threadStore";

export function MobileAppProvider({ children }: PropsWithChildren) {
  const bootstrapPairing = usePairingStore((state) => state.bootstrap);
  const seedThread = useThreadStore((state) => state.seedThread);

  useEffect(() => {
    void bootstrapPairing().catch(() => {});
    seedThread();

    const stateSubscription = addRemodexListener("stateChanged", (state) => {
      usePairingStore.setState({
        connectionState: state,
      });
    });
    const errorSubscription = addRemodexListener("secureError", (event) => {
      usePairingStore.setState({
        connectionState: {
          status: "error",
          connectedMacDeviceId: null,
          relay: null,
          sessionId: null,
          trustedMacs: [],
          lastError: event.message,
        },
      });
    });
    const syncSubscription = addRemodexListener("stateChanged", () => {
      void listTrustedMacs().then((trustedMacs) => {
        usePairingStore.setState({ trustedMacs });
      }).catch(() => {});
    });
    void getTransportState().then((state) => {
      usePairingStore.setState({ connectionState: state });
    }).catch(() => {});

    return () => {
      stateSubscription.remove();
      errorSubscription.remove();
      syncSubscription.remove();
    };
  }, [bootstrapPairing, seedThread]);

  return children;
}
