import { NextResponse } from "next/server";

import { fetchOpenAlexWorks } from "@/lib/openalex";
import { buildResearchMap } from "@/lib/scoring";
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
    return NextResponse.json(await buildResearchMap(parsed.data, works));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to generate research map."
      },
      { status: 502 }
    );
  }
}
