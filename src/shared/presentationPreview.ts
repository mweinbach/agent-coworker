import type { FileChangeVersion } from "./fileVersion";

type PresentationSlide = {
  slideIndex: number;
  slideId?: string;
  title?: string;
  pngBase64: string;
};

export type PresentationPreviewResult =
  | {
      ok: true;
      dependencies: string[];
      path: string;
      slides: PresentationSlide[];
      version: FileChangeVersion;
      renderingMode?: "rendered" | "text";
      warnings?: string[];
    }
  | {
      ok: false;
      error: { kind: "unsupported_format" | "compile_error" | "no_slides"; message: string };
    };
