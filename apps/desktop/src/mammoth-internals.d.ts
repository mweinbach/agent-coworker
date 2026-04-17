declare module "mammoth/lib/zipfile" {
  export type MammothZipFile = {
    exists(name: string): boolean;
    read(name: string, encoding?: string): Promise<string | Uint8Array>;
    write(name: string, contents: string | Uint8Array): void;
    toArrayBuffer(): Promise<ArrayBuffer>;
  };

  export function openArrayBuffer(arrayBuffer: ArrayBuffer): Promise<MammothZipFile>;
}
