import type { AcceptanceItem, Evidence, TaskDocument } from "../types.js";
import { TaskApiError } from "../mcp/api.js";

export function upgradeTask(task: TaskDocument): TaskDocument {
  if (task.schema === "checkpoint/v2") return structuredClone(task);
  // Legacy final evidence was not linked to individual criteria. Never invent verification.
  return {
    ...structuredClone(task),
    schema: "checkpoint/v2",
    archived: task.archived ?? false,
    acceptanceItems: task.acceptance.map((statement, i) => ({
      id: `AC-${i + 1}`,
      statement,
      status: "pending",
    })),
    ...(task.state === "done" ? { legacyAcceptanceReview: true } : {}),
    evidence: task.finalEvidence ?? [],
  };
}

export function assessAcceptance(
  task: TaskDocument,
  assessments: readonly {
    id: string;
    status: AcceptanceItem["status"];
    evidence_refs?: string[] | undefined;
    waiver_reason?: string | undefined;
  }[],
): void {
  const seen = new Set<string>();
  for (const assessment of assessments) {
    const item = task.acceptanceItems?.find((a) => a.id === assessment.id);
    if (!item || seen.has(assessment.id))
      throw new TaskApiError(
        "INVALID_INPUT",
        `Unknown or duplicate acceptance ID: ${assessment.id}`,
        { action: "revise_input" },
      );
    seen.add(assessment.id);
    item.status = assessment.status;
    item.evidenceRefs = [...(assessment.evidence_refs ?? [])];
    if (assessment.waiver_reason) item.waiverReason = assessment.waiver_reason;
    else delete item.waiverReason;
  }
}

export function markResumeStale(task: TaskDocument, reason: string): void {
  if (task.resume)
    task.resume = { ...task.resume, stale: true, staleReason: reason };
}

export function replaceTaskEvidence(
  task: TaskDocument,
  evidence: Evidence[],
): void {
  const changed = new Set(
    (task.evidence ?? [])
      .filter(
        (old) =>
          JSON.stringify(old) !==
          JSON.stringify(evidence.find((e) => e.id === old.id)),
      )
      .map((e) => e.id),
  );
  task.acceptanceItems = (task.acceptanceItems ?? []).map((a) =>
    a.evidenceRefs?.some((ref) => changed.has(ref))
      ? { id: a.id, statement: a.statement, status: "pending" }
      : a,
  );
  task.evidence = evidence;
}

export function durableContext(task: TaskDocument): Array<{
  checkpoint_id: string;
  checkpoint_revision: number;
  kind: "decision" | "constraint";
  statement: string;
  scope?: string;
  evidence_refs?: string[];
  reconsider_when?: string;
}> {
  return task.checkpoints
    .filter((cp) => cp.status !== "cancelled" && cp.status !== "superseded")
    .flatMap((cp) => [
      ...(cp.judgment?.constraints ?? []).map((c) => ({
        checkpoint_id: cp.id,
        checkpoint_revision: cp.revision,
        kind: "constraint" as const,
        statement: `${c.rejectedOption}: ${c.verifiedReason}; ${c.impact}`,
        scope: c.scope,
        evidence_refs: c.evidenceRefs.map((id) => `${cp.id}/${id}`),
        ...(c.reconsiderWhen ? { reconsider_when: c.reconsiderWhen } : {}),
      })),
      ...(cp.judgment?.decisions ?? []).map((statement) => ({
        checkpoint_id: cp.id,
        checkpoint_revision: cp.revision,
        kind: "decision" as const,
        statement,
      })),
    ])
    .sort(
      (a, b) =>
        Number(a.kind !== "constraint") - Number(b.kind !== "constraint"),
    );
}
