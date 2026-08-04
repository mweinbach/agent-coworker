export const meta = {
  name: "deep-research",
  description:
    "Plan a bounded research program, gather source-backed claims, independently verify each claim, and synthesize a coverage-aware report.",
  phases: ["plan", "research", "verify", "synthesize"],
};

export default async function run({ agent, parallel, phase, log, args }) {
  const text = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const fullText = (value) => (typeof value === "string" ? value.trim() : "");
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
  const comprehensiveSourceList = (value) =>
    Array.isArray(value)
      ? value
          .map((source) => ({
            title: fullText(source?.title),
            locator: fullText(source?.locator),
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
      reportMarkdown: { type: "string" },
      sources: {
        type: "array",
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
      limitations: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
    },
    required: ["claims", "reportMarkdown", "sources", "limitations"],
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
            `and return at most ${maxClaimsPerQuestion} decision-relevant claims for independent verification. ` +
            "The claims list is an index, not a substitute for the research. In reportMarkdown, write a comprehensive, self-contained research section that preserves all substantive findings, evidence, dates, figures, examples, methodology, disagreements, caveats, and source context. " +
            "Do not compress the section into a summary or omit details merely because they are not selected as verification claims. Cite source locators inline and include every source used in the top-level sources bibliography. " +
            "Every verification claim must include concrete source locators such as URLs or exact document/file references. State uncertainty honestly. An empty claim list is valid only after searching.",
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

  const researchReports = [];
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
    const shardLimitations = result.limitations
      .map((limitation) => fullText(limitation))
      .filter(Boolean);
    for (const normalized of shardLimitations) {
      if (normalized) limitations.push(`${question.title}: ${normalized}`);
    }
    const reportMarkdown = fullText(result.reportMarkdown);
    const researchSources = comprehensiveSourceList(result.sources);
    if (!reportMarkdown)
      limitations.push(`Research shard returned no detailed report: ${question.title}`);
    if (researchSources.length === 0)
      limitations.push(`Research shard returned no bibliography: ${question.title}`);
    researchReports.push({
      questionIndex: question.index,
      question: question.title,
      focus: question.focus,
      reportMarkdown,
      sources: researchSources,
      limitations: shardLimitations,
    });
    for (const claim of result.claims.slice(0, maxClaimsPerQuestion)) {
      const statement = fullText(claim.statement);
      const evidence = fullText(claim.evidence);
      const sources = sourceList(claim.sources);
      if (!statement || !evidence || sources.length === 0) {
        limitations.push(`Dropped unsupported candidate from: ${question.title}`);
        continue;
      }
      candidateClaims.push({
        candidateIndex: candidateClaims.length,
        questionIndex: question.index,
        question: question.title,
        statement,
        evidence,
        sources,
        uncertainty: fullText(claim.uncertainty),
      });
    }
  }

  const verificationSchema = {
    type: "object",
    properties: {
      claims: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            candidateIndex: { type: "integer" },
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
          required: [
            "candidateIndex",
            "verified",
            "reason",
            "evidence",
            "sources",
            "correctedStatement",
          ],
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
  const researchReportByQuestionIndex = new Map(
    researchReports.map((report) => [report.questionIndex, report]),
  );
  const verificationBatches = questions
    .map((question) => ({
      question,
      researchReport: researchReportByQuestionIndex.get(question.index),
      claims: candidateClaims.filter((claim) => claim.questionIndex === question.index),
    }))
    .filter((batch) => batch.claims.length > 0);

  phase("verify");
  const verificationResults = await parallel(
    verificationBatches.map(
      (batch) => () =>
        agent(
          "Independently and adversarially verify every candidate claim from this research shard. The complete shard report is included for context; review it rather than relying only on the claim summaries. Do not trust the researcher report or cited sources without checking them. " +
            "Use web search and direct retrieval to find independent support or contradiction. Return exactly one result for each candidateIndex and no extras. " +
            "Set verified=true only when concrete evidence and usable source locators support the statement. If a claim needs narrowing, put the defensible version in correctedStatement; otherwise repeat the original statement. Missing evidence means verified=false. " +
            "Use limitations to record any material report-wide omissions, contradictions, or source-quality problems you notice.\n\n" +
            JSON.stringify({
              query,
              question: batch.question,
              researchReportMarkdown: batch.researchReport?.reportMarkdown || "",
              researchSources: batch.researchReport?.sources || [],
              claims: batch.claims.map((claim) => ({
                candidateIndex: claim.candidateIndex,
                statement: claim.statement,
                evidence: claim.evidence,
                sources: claim.sources,
                uncertainty: claim.uncertainty,
              })),
            }),
          {
            label: `verify:${batch.question.index + 1}`,
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

  const verificationByCandidateIndex = new Map();
  for (let index = 0; index < verificationBatches.length; index += 1) {
    const batch = verificationBatches[index];
    const result = verificationResults[index];
    if (!result) {
      limitations.push(`Verification shard failed: ${batch.question.title}`);
      continue;
    }
    for (const limitation of result.limitations) {
      const normalized = fullText(limitation);
      if (normalized) limitations.push(`${batch.question.title}: ${normalized}`);
    }
    const allowedIndexes = new Set(batch.claims.map((claim) => claim.candidateIndex));
    for (const verification of result.claims) {
      if (!allowedIndexes.has(verification.candidateIndex)) continue;
      verificationByCandidateIndex.set(verification.candidateIndex, verification);
    }
  }

  const claimAssessments = [];
  const verifiedClaims = [];
  let droppedClaims = 0;
  for (let index = 0; index < candidateClaims.length; index += 1) {
    const candidate = candidateClaims[index];
    const verification = verificationByCandidateIndex.get(candidate.candidateIndex);
    const sources = sourceList(verification?.sources);
    const evidence = fullText(verification?.evidence);
    const verificationReason = fullText(verification?.reason);
    const correctedStatement = fullText(verification?.correctedStatement) || candidate.statement;
    const verified = Boolean(verification?.verified && evidence && sources.length > 0);
    claimAssessments.push({
      question: candidate.question,
      originalStatement: candidate.statement,
      originalEvidence: candidate.evidence,
      originalSources: candidate.sources,
      uncertainty: candidate.uncertainty,
      verified,
      correctedStatement,
      verificationReason,
      verificationEvidence: evidence,
      verificationSources: sources,
    });
    if (!verified) {
      droppedClaims += 1;
      limitations.push(`Unverified claim dropped: ${text(candidate.statement, 180)}`);
      continue;
    }
    verifiedClaims.push({
      question: candidate.question,
      statement: correctedStatement,
      evidence,
      sources,
      uncertainty: candidate.uncertainty,
      verificationReason,
      researchStatement: candidate.statement,
      researchEvidence: candidate.evidence,
      researchSources: candidate.sources,
    });
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
    "Write a rigorous, comprehensive, full-length deep-research report. The complete researchReports are the full section drafts, not summaries. Preserve and integrate all substantive detail from every shard, including evidence, dates, figures, examples, methodology, disagreements, caveats, and source context. " +
      "Do not replace each shard with a short summary, and do not omit details merely because they were not selected as verification claims. Give every planned question a substantial section and deduplicate only genuinely repeated material. " +
      "Use claimAssessments as the verification layer: present verified corrected claims as established, clearly label uncertain or unverified material, and never present contradicted or unsupported material as fact. Do not add facts from memory. " +
      "Cite source locators inline, distinguish fact from uncertainty, mention meaningful disagreements, and include a Coverage limitations section. If there are no verified claims, explain that limitation while still preserving the sourced research record. Return polished Markdown in reportMarkdown.\n\n" +
      JSON.stringify({
        query,
        researchReports,
        claimAssessments,
        verifiedClaims,
        limitations,
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

  const completeResearchRecord = researchReports
    .map((report, index) => {
      const bibliography = report.sources
        .map((source) => `- ${source.title ? `${source.title}: ` : ""}${source.locator}`)
        .join("\n");
      return (
        `### ${index + 1}. ${report.question}\n\n` +
        `**Research focus:** ${report.focus}\n\n` +
        `${report.reportMarkdown || "No detailed report was returned for this shard."}\n\n` +
        `#### Complete Source List\n\n${bibliography || "No sources were returned for this shard."}`
      );
    })
    .join("\n\n");
  const reportMarkdown = [
    fullText(synthesis.reportMarkdown),
    completeResearchRecord
      ? "## Complete Research Record\n\nThe following sections preserve every research shard in full, without summarization.\n\n" +
        completeResearchRecord
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

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
    reportMarkdown,
    researchReports,
    claimAssessments,
    verifiedClaims,
    coverage: {
      plannedQuestions: questions.length,
      completedResearchShards,
      candidateClaims: candidateClaims.length,
      verifiedClaims: verifiedClaims.length,
      droppedClaims,
      limitations,
    },
  };
}
