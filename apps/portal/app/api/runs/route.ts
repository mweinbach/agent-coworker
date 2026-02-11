import { NextResponse } from "next/server";

import { getHarnessRunsSnapshot } from "@/lib/harness";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitRaw = Number(searchParams.get("limitRoots") ?? "30");
  const limitRoots = Number.isFinite(limitRaw) ? limitRaw : 30;

  const snapshot = await getHarnessRunsSnapshot({ limitRoots });
  return NextResponse.json(snapshot);
}
