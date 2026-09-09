import type {
  BlockManifest,
  CheckpointCore,
  DurableConstraint,
  Evidence,
  ResumeCapsule,
} from "../types";
import { escapeBackticks, escapeHeading, oneLine } from "./text";

const EVIDENCE_LABELS: Record<Evidence["type"], string> = {
  test: "测试",
  artifact: "产物",
  observation: "观察",
  source: "来源",
  user_acceptance: "用户验收",
};

const BLOCK_KIND_LABELS: Record<BlockManifest["kind"], string> = {
  data_table: "数据表",
  mermaid: "Mermaid",
  domain_checklist: "领域清单",
  code_or_config: "代码/配置",
  test_evidence: "测试证据",
  technical_spec: "技术规格",
  source_reference: "来源",
};

function statusLabel(
  status: CheckpointCore["objective"]["acceptance"][number]["status"],
): string {
  switch (status) {
    case "pending":
      return "待验证";
    case "verified":
      return "已验证";
    case "waived":
      return "已豁免";
  }
}

function renderConstraint(constraint: DurableConstraint): string {
  const parts = [
    `不采用 ${oneLine(constraint.rejectedOption)}`,
    `已验证原因：${oneLine(constraint.verifiedReason)}`,
    `范围：${oneLine(constraint.scope)}`,
    `影响：${oneLine(constraint.impact)}`,
    `证据：${constraint.evidenceRefs.map(oneLine).join("、")}`,
  ];
  if (constraint.reconsiderWhen !== undefined) {
    parts.push(`重新评估条件：${oneLine(constraint.reconsiderWhen)}`);
  }
  return parts.join("；");
}

function renderEvidence(evidence: Evidence): string {
  const ref = evidence.ref === undefined ? "" : `（${oneLine(evidence.ref)}）`;
  return `- 证据（${EVIDENCE_LABELS[evidence.type]}，${oneLine(evidence.id)}）${ref}：${oneLine(evidence.statement)}`;
}

export function renderBlockManifest(manifest: BlockManifest): string {
  const path = escapeBackticks(manifest.path);
  return `- \`${oneLine(manifest.id)}\` · **${oneLine(manifest.title)}**（${BLOCK_KIND_LABELS[manifest.kind]}，${manifest.chars} 字，r${manifest.revision}）：${oneLine(manifest.summary)} — [[${path}]]`;
}

export function renderCheckpointCore(
  checkpoint: CheckpointCore,
  displayIndex = 1,
  options: { includeBlockManifest?: boolean } = {},
): string {
  const lines: string[] = [
    `## CP-${String(displayIndex).padStart(2, "0")} · ${escapeHeading(checkpoint.title)}`,
    "",
    "### 目标与验收",
    `- 目标：${oneLine(checkpoint.objective.statement)}`,
  ];

  for (const acceptance of checkpoint.objective.acceptance) {
    const evidence = acceptance.evidenceRefs?.length
      ? `；证据：${acceptance.evidenceRefs.map(oneLine).join("、")}`
      : "";
    lines.push(
      `- 完成条件（${oneLine(acceptance.id)}，${statusLabel(acceptance.status)}）：${oneLine(acceptance.statement)}${evidence}`,
    );
  }

  const facts = checkpoint.judgment?.facts ?? [];
  const decisions = checkpoint.judgment?.decisions ?? [];
  const constraints = checkpoint.judgment?.constraints ?? [];
  if (facts.length + decisions.length + constraints.length > 0) {
    lines.push("", "### 关键判断");
    for (const finding of facts) {
      lines.push(
        `- 已确认事实：${oneLine(finding.fact)}（相关性：${oneLine(finding.relevance)}）`,
      );
    }
    for (const decision of decisions) {
      lines.push(`- 决定：${oneLine(decision)}`);
    }
    for (const constraint of constraints) {
      lines.push(`- 永久约束：${renderConstraint(constraint)}`);
    }
  }

  if (checkpoint.outcome !== undefined) {
    lines.push(
      "",
      "### 结果与证据",
      `- 结果：${oneLine(checkpoint.outcome.summary)}`,
    );
    for (const evidence of checkpoint.outcome.evidence) {
      lines.push(renderEvidence(evidence));
    }
    for (const risk of checkpoint.outcome.residualRisks ?? []) {
      lines.push(`- 剩余风险：${oneLine(risk)}`);
    }
  }

  if (checkpoint.status === "blocked") {
    lines.push(
      "",
      "### 阻塞",
      `- 阻塞原因：${oneLine(checkpoint.blocker ?? "")}`,
      `- 解除条件：${oneLine(checkpoint.unblockCondition ?? "")}`,
    );
  }

  if (checkpoint.status === "cancelled") {
    lines.push(
      "",
      "### 取消处置",
      `- 原因：${oneLine(checkpoint.cancellation?.reason ?? "")}`,
      `- 处置：${oneLine(checkpoint.cancellation?.disposition ?? "")}`,
    );
  }

  if (checkpoint.status === "superseded") {
    lines.push(
      "",
      "### 替代关系",
      `- 已由 checkpoint \`${oneLine(checkpoint.supersededBy ?? "")}\` 替代。`,
    );
  }

  if (options.includeBlockManifest !== false && checkpoint.blocks.length > 0) {
    lines.push("", "### 详细资料");
    for (const block of checkpoint.blocks) {
      lines.push(renderBlockManifest(block));
    }
  }

  return lines.join("\n").trimEnd();
}

export function renderResumeCallout(
  resume: ResumeCapsule,
  checkpoints: readonly CheckpointCore[],
): string {
  const index = checkpoints.findIndex(
    (checkpoint) => checkpoint.id === resume.focusCheckpointId,
  );
  const checkpoint = index < 0 ? undefined : checkpoints[index];
  const current =
    checkpoint === undefined
      ? resume.focusCheckpointId
        ? escapeBackticks(resume.focusCheckpointId)
        : "任务整体"
      : `CP-${String(index + 1).padStart(2, "0")} · ${oneLine(checkpoint.title)}`;
  const lines = ["> [!taskdoc-resume] 当前接续点", `> 当前：${current}  `];
  if (resume.stale)
    lines.push(
      `> ⚠ 接续点待复核：${oneLine(resume.staleReason ?? "任务内容已变化")}  `,
    );

  if (resume.lastVerified !== undefined) {
    lines.push(`> 最后验证：${oneLine(resume.lastVerified)}  `);
  }
  lines.push(`> 下一步：${oneLine(resume.nextAction)}  `);

  for (const blocker of resume.blockers) {
    lines.push(
      `> 阻塞：${oneLine(blocker.statement)}；解除条件：${oneLine(blocker.unblockWhen)}  `,
    );
  }
  if (resume.openQuestions.length > 0) {
    lines.push(`> 待确认：${resume.openQuestions.map(oneLine).join("；")}  `);
  }
  for (const check of resume.pendingChecks ?? [])
    lines.push(`> 待验证：${oneLine(check)}  `);
  if (resume.workingArtifacts.length > 0) {
    const artifacts = resume.workingArtifacts.map(
      (artifact) =>
        `\`${escapeBackticks(artifact.path)}\`（${oneLine(artifact.purpose)}；${artifact.state}）`,
    );
    lines.push(`> 工作文件：${artifacts.join("；")}  `);
  }
  if (resume.workspaceRef !== undefined) {
    const refs = [
      resume.workspaceRef.repo,
      resume.workspaceRef.branch,
      resume.workspaceRef.commit,
    ]
      .filter(
        (entry): entry is string =>
          entry !== undefined && entry.trim().length > 0,
      )
      .map(oneLine);
    if (refs.length > 0) {
      lines.push(`> 工作区：${refs.join(" · ")}`);
    }
  }

  return lines.join("\n").replace(/[ ]+$/gm, "").trimEnd();
}
