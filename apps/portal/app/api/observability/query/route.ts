import { NextResponse } from "next/server";

import { runObservabilityQuery, type ObservabilityQueryRequest } from "@/lib/observability";

export const dynamic = "force-dynamic";

function isQueryType(v: unknown): v is ObservabilityQueryRequest["queryType"] {
  return v === "logql" || v === "promql" || v === "traceql";
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (!payload) return NextResponse.json({ error: "Expected object body" }, { status: 400 });

  if (!isQueryType(payload.queryType)) {
    return NextResponse.json({ error: "Invalid queryType" }, { status: 400 });
  }
  if (typeof payload.query !== "string") {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  const reqPayload: ObservabilityQueryRequest = {
    queryType: payload.queryType,
    query: payload.query,
    fromMs: typeof payload.fromMs === "number" ? payload.fromMs : undefined,
    toMs: typeof payload.toMs === "number" ? payload.toMs : undefined,
    limit: typeof payload.limit === "number" ? payload.limit : undefined,
  };

  try {
    const result = await runObservabilityQuery(reqPayload);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: `Query failed: ${String(err)}` }, { status: 500 });
  }
}
