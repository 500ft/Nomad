import { NextResponse } from "next/server";

import { fetchOpenAlexWorks } from "@/lib/openalex";
import { buildV2ResearchMap } from "@/lib/quality/v2-pipeline";
import { researchMapRequestSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = researchMapRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid research map request.",
        issues: parsed.error.flatten().fieldErrors
      },
      { status: 400 }
    );
  }

  try {
    const works = await fetchOpenAlexWorks(parsed.data);
    return NextResponse.json(await buildV2ResearchMap(parsed.data, works));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to generate research map."
      },
      { status: 502 }
    );
  }
}
