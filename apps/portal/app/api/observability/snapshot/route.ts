import { NextResponse } from "next/server";

import { getObservabilitySnapshot } from "@/lib/observability";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getObservabilitySnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json({ error: `Snapshot failed: ${String(err)}` }, { status: 500 });
  }
}
