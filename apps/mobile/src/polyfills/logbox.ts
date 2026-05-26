type LogBoxExceptionRecord = Record<string, unknown>;

declare const __DEV__: boolean | undefined;

function readString(record: LogBoxExceptionRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readBoolean(record: LogBoxExceptionRecord, key: string): boolean {
  return typeof record[key] === "boolean" ? record[key] : false;
}

export function normalizeLogBoxException(input: unknown): unknown {
  if (input === null || typeof input !== "object") {
    return input;
  }

  const record = input as LogBoxExceptionRecord;
  if (Array.isArray(record.stack)) {
    return input;
  }

  const message = readString(record, "message") ?? "Unknown";
  const originalMessage = readString(record, "originalMessage") ?? message;
  const rawStack = readString(record, "stack");
  const extraData =
    record.extraData !== null && typeof record.extraData === "object"
      ? record.extraData
      : { rawStack };

  return {
    ...record,
    message,
    originalMessage,
    name: readString(record, "name"),
    componentStack: readString(record, "componentStack"),
    stack: [],
    isFatal: readBoolean(record, "isFatal"),
    isComponentError: readBoolean(record, "isComponentError"),
    extraData,
  };
}

type InternalLogBox = {
  __coworkExceptionStackPatch?: true;
  addException?: (error: unknown) => void;
};

export function installLogBoxExceptionStackPatch() {
  const devFlag = typeof __DEV__ === "undefined" ? false : __DEV__;
  if (!devFlag || typeof document !== "undefined") {
    return;
  }

  const internalLogBox = require("react-native/Libraries/LogBox/LogBox").default as InternalLogBox;
  if (internalLogBox.__coworkExceptionStackPatch || !internalLogBox.addException) {
    return;
  }

  const addException = internalLogBox.addException.bind(internalLogBox);
  internalLogBox.addException = (error: unknown) => {
    addException(normalizeLogBoxException(error));
  };
  internalLogBox.__coworkExceptionStackPatch = true;
}
