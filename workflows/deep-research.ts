export const meta = {
  name: "deep-research",
  description:
    "Plan a bounded research program, gather source-backed claims, independently verify each claim, and synthesize a coverage-aware report.",
  phases: ["plan", "research", "verify", "synthesize"],
};

export default async function run({ agent, parallel, phase, log, args }) {
  const text = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const integer = (value, fallback, min, max) => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(numeric)));
  };
  const sourceList = (value) =>
    Array.isArray(value)
      ? value
          .slice(0, 3)
          .map((source) => ({
            title: text(source?.title, 120),
            locator: text(source?.locator, 400),
          }))
          .filter((source) => source.locator)
      : [];

  const query = text(args?.query, 4_000);
  if (!query) {
    throw new Error('deep-research requires args.query, for example { "query": "..." }');
  }

  const maxQuestions = integer(args?.maxQuestions, 5, 2, 6);
  const maxClaimsPerQuestion = integer(args?.maxClaimsPerQuestion, 4, 1, 4);
  const defaultModel = text(args?.model, 300);
  const plannerModel = text(args?.plannerModel, 300) || defaultModel;
  const researchModel = text(args?.researchModel, 300) || defaultModel;
  const verificationModel = text(args?.verificationModel, 300) || defaultModel;
  const synthesisModel = text(args?.synthesisModel, 300) || defaultModel;
  const limitations = [];

  const planSchema = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            focus: { type: "string" },
          },
          required: ["title", "focus"],
          additionalProperties: false,
        },
      },
      planningLimitations: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
    },
    required: ["questions", "planningLimitations"],
    additionalProperties: false,
  };

  phase("plan");
  const plan = await agent(
    `Plan a deep research program for the following query:\n\n${query}\n\n` +
      `Return ${maxQuestions} non-overlapping questions that collectively cover the query. ` +
      "Prioritize primary sources, current authoritative material, competing explanations, and decision-relevant uncertainty. " +
      "Keep each question focused enough for one independent researcher.",
    {
      label: "research-plan",
      phase: "plan",
      agentType: "research",
      effort: "high",
      ...(plannerModel ? { model: plannerModel } : {}),
      schema: planSchema,
    },
  );

  const questions = plan.questions.slice(0, maxQuestions).map((question, index) => ({
    index,
    title: text(question.title, 240),
    focus: text(question.focus, 800),
  }));
  for (const limitation of plan.planningLimitations) {
    const normalized = text(limitation, 500);
    if (normalized) limitations.push(`Planning: ${normalized}`);
  }

  const researchSchema = {
    type: "object",
    properties: {
      claims: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            statement: { type: "string" },
            evidence: { type: "string" },
            sources: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  locator: { type: "string" },
                },
                required: ["title", "locator"],
                additionalProperties: false,
              },
            },
            uncertainty: { type: "string" },
          },
          required: ["statement", "evidence", "sources", "uncertainty"],
          additionalProperties: false,
        },
      },
      limitations: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
    },
    required: ["claims", "limitations"],
    additionalProperties: false,
  };

  phase("research");
  const researchResults = await parallel(
    questions.map(
      (question) => () =>
        agent(
          `Research this part of a larger deep-research request.\n\nOverall query:\n${query}\n\n` +
            `Assigned question:\n${question.title}\n${question.focus}\n\n` +
            `Use web search and direct source retrieval. Prefer primary and authoritative sources, cross-check important claims, ` +
            `and return at most ${maxClaimsPerQuestion} decision-relevant claims. Every claim must include concrete source locators ` +
            "such as URLs or exact document/file references. State uncertainty honestly. An empty claim list is valid only after searching.",
          {
            label: `research:${question.index + 1}`,
            phase: "research",
            agentType: "research",
            effort: "high",
            ...(researchModel ? { model: researchModel } : {}),
            schema: researchSchema,
            onError: "null",
          },
        ),
    ),
  );

  const candidateClaims = [];
  let completedResearchShards = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const result = researchResults[index];
    const question = questions[index];
    if (!result) {
      limitations.push(`Research shard failed: ${question.title}`);
      continue;
    }
    completedResearchShards += 1;
    for (const limitation of result.limitations) {
      const normalized = text(limitation, 500);
      if (normalized) limitations.push(`${question.title}: ${normalized}`);
    }
    for (const claim of result.claims.slice(0, maxClaimsPerQuestion)) {
      const statement = text(claim.statement, 600);
      const evidence = text(claim.evidence, 1_000);
      const sources = sourceList(claim.sources);
      if (!statement || !evidence || sources.length === 0) {
        limitations.push(`Dropped unsupported candidate from: ${question.title}`);
        continue;
      }
      candidateClaims.push({
        question: question.title,
        statement,
        evidence,
        sources,
        uncertainty: text(claim.uncertainty, 500),
      });
    }
  }

  const verificationSchema = {
    type: "object",
    properties: {
      verified: { type: "boolean" },
      reason: { type: "string" },
      evidence: { type: "string" },
      sources: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            locator: { type: "string" },
          },
          required: ["title", "locator"],
          additionalProperties: false,
        },
      },
      correctedStatement: { type: "string" },
    },
    required: ["verified", "reason", "evidence", "sources", "correctedStatement"],
    additionalProperties: false,
  };

  phase("verify");
  const verificationResults = await parallel(
    candidateClaims.map(
      (claim, index) => () =>
        agent(
          "Independently and adversarially verify this research claim. Do not trust the researcher summary or cited sources without checking them. " +
            "Use web search and direct retrieval to find independent support or contradiction. Set verified=true only when concrete evidence and usable source locators support the statement. " +
            "If the claim needs narrowing, put the defensible version in correctedStatement; otherwise repeat the original statement. Missing evidence means verified=false.\n\n" +
            JSON.stringify({ query, claim }),
          {
            label: `verify:${index + 1}`,
            phase: "verify",
            agentType: "research",
            effort: "high",
            ...(verificationModel ? { model: verificationModel } : {}),
            schema: verificationSchema,
            onError: "null",
          },
        ),
    ),
  );

  const verifiedClaims = [];
  let droppedClaims = 0;
  for (let index = 0; index < candidateClaims.length; index += 1) {
    const candidate = candidateClaims[index];
    const verification = verificationResults[index];
    const sources = sourceList(verification?.sources);
    const evidence = text(verification?.evidence, 1_000);
    if (!verification?.verified || !evidence || sources.length === 0) {
      droppedClaims += 1;
      limitations.push(`Unverified claim dropped: ${text(candidate.statement, 180)}`);
      continue;
    }
    verifiedClaims.push({
      question: candidate.question,
      statement: text(verification.correctedStatement, 600) || candidate.statement,
      evidence,
      sources,
      uncertainty: candidate.uncertainty,
      verificationReason: text(verification.reason, 500),
    });
  }

  const maxSynthesisClaims = 12;
  const synthesisClaims = verifiedClaims.slice(0, maxSynthesisClaims);
  if (verifiedClaims.length > maxSynthesisClaims) {
    limitations.push(
      `${verifiedClaims.length - maxSynthesisClaims} verified claims were omitted from final synthesis to keep the report prompt bounded.`,
    );
  }

  const synthesisSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      executiveSummary: { type: "string" },
      reportMarkdown: { type: "string" },
    },
    required: ["title", "executiveSummary", "reportMarkdown"],
    additionalProperties: false,
  };

  phase("synthesize");
  log(
    `${verifiedClaims.length}/${candidateClaims.length} candidate claims survived independent verification.`,
  );
  const synthesis = await agent(
    "Write a rigorous deep-research report using only the independently verified claims supplied below. " +
      "Do not add facts from memory. Cite source locators inline, distinguish fact from uncertainty, mention meaningful disagreements, and include a Coverage limitations section. " +
      "If there are no verified claims, say that the available research did not support a reliable answer. Return polished Markdown in reportMarkdown.\n\n" +
      JSON.stringify({
        query,
        verifiedClaims: synthesisClaims.map((claim) => ({
          statement: claim.statement,
          sources: claim.sources,
          uncertainty: claim.uncertainty,
        })),
        limitations: limitations.slice(0, 30),
      }),
    {
      label: "research-synthesis",
      phase: "synthesize",
      agentType: "research",
      effort: "high",
      ...(synthesisModel ? { model: synthesisModel } : {}),
      schema: synthesisSchema,
    },
  );

  const status =
    limitations.length > 0 ||
    droppedClaims > 0 ||
    completedResearchShards < questions.length ||
    verifiedClaims.length === 0
      ? "partial"
      : "complete";

  return {
    status,
    query,
    title: synthesis.title,
    executiveSummary: synthesis.executiveSummary,
    reportMarkdown: synthesis.reportMarkdown,
    verifiedClaims,
    coverage: {
      plannedQuestions: questions.length,
      completedResearchShards,
      candidateClaims: candidateClaims.length,
      verifiedClaims: verifiedClaims.length,
      droppedClaims,
      limitations: limitations.slice(0, 30),
    },
  };
}
