import { NextResponse } from "next/server";

import { getHarnessRunsSnapshot } from "@/lib/harness";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitRaw = Number(searchParams.get("limitRoots") ?? "30");
  const limitRoots = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 30));

  try {
    const snapshot = await getHarnessRunsSnapshot({ limitRoots });
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json({ error: `Failed to list runs: ${String(err)}` }, { status: 500 });
  }
}
