import { NextResponse } from "next/server";

import { getObservabilitySnapshot } from "@/lib/observability";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getObservabilitySnapshot();
  return NextResponse.json(snapshot);
}
