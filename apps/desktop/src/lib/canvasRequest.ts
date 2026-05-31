/**
 * Structured prompt envelope for Cowork's embedded document/text/slide canvas.
 *
 * Mirrors the spreadsheet canvas envelope (`lib/univerSpreadsheet.ts#buildUniverSpreadsheetPrompt`)
 * so every canvas surface sends the agent the same kind of XML context, and the
 * chat transcript can render all of them through one parser/bubble
 * (`ui/chat/feedMessageParsing.ts#parseCanvasRequest`).
 */

function escapeXml(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requestLooksLikeFeedback(request: string): boolean {
  return /\b(what do you think|thoughts?|feedback|opinion|comment|review|analy[sz]e|assessment)\b/i.test(
    request,
  );
}

export function buildCanvasDocumentPrompt(opts: {
  path: string;
  fileName: string;
  kind: string;
  selection: string | null;
  request: string;
}): string {
  const feedbackMode = requestLooksLikeFeedback(opts.request)
    ? "answer_without_editing"
    : "edit_when_requested";
  const selection = opts.selection?.trim();
  const selectionXml = selection ? `\n  <selection>${escapeXml(selection)}</selection>` : "";

  return `<canvas_request version="1" source="document">
  <assistant_instructions>
    <instruction>Treat this as structured context from Cowork's embedded document canvas.</instruction>
    <instruction mode="${feedbackMode}">${
      feedbackMode === "answer_without_editing"
        ? "The user is asking for feedback or analysis; answer directly unless they explicitly ask for file changes."
        : "If the user asks for document changes, edit the local file and summarize the exact changes."
    }</instruction>
  </assistant_instructions>
  <file name="${escapeXml(opts.fileName)}" path="${escapeXml(opts.path)}" kind="${escapeXml(
    opts.kind,
  )}" />${selectionXml}
  <user_request>${escapeXml(opts.request)}</user_request>
</canvas_request>`;
}
