type CanvasSaveAsFlowOptions = {
  sourcePath: string;
  pickPath: (input: { sourcePath: string }) => Promise<string | null>;
  saveAs: (path: string) => Promise<string | null>;
  reportFailure: (message: string) => void;
};

export async function runCanvasSaveAs(options: CanvasSaveAsFlowOptions): Promise<string | null> {
  try {
    const targetPath = await options.pickPath({ sourcePath: options.sourcePath });
    if (!targetPath) {
      return null;
    }
    return await options.saveAs(targetPath);
  } catch (error) {
    options.reportFailure(error instanceof Error ? error.message : String(error));
    return null;
  }
}
