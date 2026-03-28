import type { PairingQrPayload } from "./pairingTypes";

type PairingValidationResult =
  | { success: true; data: PairingQrPayload }
  | { success: false; error: string };

type PairingScanHandlerOptions = {
  validatePairingPayload: (rawValue: string) => PairingValidationResult;
  connectWithQr: (payload: PairingQrPayload) => Promise<void>;
  setScannedPayload: (payload: string | null) => void;
  onSuccess: () => void | Promise<void>;
  onInvalidPayload: (message: string) => void;
  onPairingError: (message: string) => void;
};

export function createPairingScanHandler(options: PairingScanHandlerOptions) {
  let pairingAttemptInFlight = false;

  return {
    isPairingAttemptInFlight() {
      return pairingAttemptInFlight;
    },
    async handleScan(result: { data: string }) {
      if (pairingAttemptInFlight) {
        return;
      }

      const parsed = options.validatePairingPayload(result.data);
      if (!parsed.success) {
        options.onInvalidPayload(parsed.error);
        return;
      }

      pairingAttemptInFlight = true;
      options.setScannedPayload(JSON.stringify(parsed.data, null, 2));

      try {
        await options.connectWithQr(parsed.data);
        await options.onSuccess();
      } catch (error) {
        pairingAttemptInFlight = false;
        options.setScannedPayload(null);
        options.onPairingError(
          error instanceof Error ? error.message : "Could not start the secure transport session.",
        );
      }
    },
  };
}
