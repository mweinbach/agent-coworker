import { NextResponse } from "next/server";

import { getHarnessRunDetail } from "@/lib/harness";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runRoot = searchParams.get("runRoot") ?? "";
  const runDir = searchParams.get("runDir") ?? "";

  if (!runRoot || !runDir) {
    return NextResponse.json({ error: "Missing runRoot or runDir" }, { status: 400 });
  }

  const detail = await getHarnessRunDetail(runRoot, runDir);
  if (!detail) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
