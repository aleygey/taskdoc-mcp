import { z } from "zod";

const id = z.string().trim().min(1).max(128).describe("稳定 ID；必须使用工具返回的值，不要使用标题或自行猜测");
const requestId = z.string().trim().min(8).max(128).describe("本次写操作的幂等键；重试同一请求时保持不变，新操作必须更换");
const revision = z.number().int().min(0).describe("期望版本号，用于并发校验；从最近一次读取或写入结果获取，冲突后先重新读取");
const shortText = z.string().trim().min(1).max(240).describe("简洁的单条长期信息，不写对话、过程播报或临时方案");
const evidenceType = z
  .enum(["test", "artifact", "observation", "source", "user_acceptance"])
  .describe("证据类型：测试、产物、观测、来源或用户验收");

export const taskCatalogInputSchema = z.object({}).strict().describe("无需参数；返回插件中已配置的看板及列 ID");

export const taskQueryInputSchema = z
  .object({
    board_id: id.describe("看板 ID；省略则查询全部已配置看板").optional(),
    column_id: id.describe("看板列 ID（任务类型）；必须属于 board_id 对应的列").optional(),
    state: z.enum(["active", "done", "archived"]).describe("任务状态：进行中、已完成或已归档").optional(),
    query: z.string().trim().min(1).max(200).describe("按任务标题进行不区分大小写的文本筛选").optional(),
    cursor: z.string().trim().min(1).max(512).describe("上一页返回的游标；首页省略").optional(),
    limit: z.number().int().min(1).max(100).default(20).describe("本页最多返回的任务数，默认 20，最大 100"),
  })
  .strict();

export const taskResumeInputSchema = z
  .object({
    task_id: id.describe("要跨 session 接续的任务 ID"),
    completed_limit: z.number().int().min(0).max(100).default(20).describe("最多返回多少条已完成 checkpoint 摘要；0 表示不返回"),
    cursor: z.string().trim().min(1).max(512).describe("已完成 checkpoint 摘要的下一页游标；首页省略").optional(),
  })
  .strict();

export const taskReadInputSchema = z
  .object({
    task_id: id.describe("要读取的任务 ID"),
    view: z.enum(["outline", "checkpoint", "block"]).default("outline").describe("读取视图：任务大纲、单个 checkpoint 核心，或单个富内容块"),
    checkpoint_id: id.describe("checkpoint ID；view=checkpoint 或 block 时必填").optional(),
    block_id: id.describe("富内容块 ID；仅 view=block 时必填").optional(),
    cursor: z.string().trim().min(1).max(512).describe("outline 或 block 的下一页游标；首页省略").optional(),
    checkpoint_limit: z.number().int().min(1).max(100).default(20).describe("outline 每页最多返回的 checkpoint 数，默认 20"),
    max_chars: z.number().int().min(256).max(8192).default(4096).describe("block 视图每页最多返回的字符数，默认 4096，最大 8192"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.view !== "outline" && value.checkpoint_id === undefined) {
      context.addIssue({ code: "custom", path: ["checkpoint_id"], message: `${value.view} view requires checkpoint_id` });
    }
    if (value.view === "block" && value.block_id === undefined) {
      context.addIssue({ code: "custom", path: ["block_id"], message: "block view requires block_id" });
    }
    if (value.view !== "block" && value.block_id !== undefined) {
      context.addIssue({ code: "custom", path: ["view"], message: "block_id is only valid for block view" });
    }
    if (value.view === "checkpoint" && value.cursor !== undefined) {
      context.addIssue({ code: "custom", path: ["cursor"], message: "cursor is only valid for outline or block view" });
    }
  });

export const taskCreateInputSchema = z
  .object({
    schema_version: z.literal(1).describe("写入契约版本；当前固定为 1"),
    request_id: requestId,
    board_id: id.describe("目标看板 ID；先通过 task_catalog 获取"),
    column_id: id.describe("初始看板列 ID（任务类型）；先通过 task_catalog 获取，不可自由填写"),
    expected_board_revision: revision.describe("可选的看板期望版本；提供时用于防止并发覆盖").optional(),
    title: z.string().trim().min(2).max(40).describe("任务标题，2–40 字；同时用于文档标题和看板卡片"),
    objective: z.string().trim().min(1).max(1_000).describe("任务级目标：最终要解决什么；只写稳定需求，不写执行过程"),
    acceptance: z.array(shortText).min(1).max(20).describe("任务级验收条件列表；每项应可验证，1–20 项"),
  })
  .strict();

export const taskCardUpdateInputSchema = z
  .object({
    schema_version: z.literal(1).describe("写入契约版本；当前固定为 1"),
    request_id: requestId,
    task_id: id.describe("要移动看板卡片或重新打开的任务 ID"),
    expected_revision: revision,
    column_id: id.describe("要移动到的现有列 ID；列就是用户配置的任务类型，不可自行发明").optional(),
    state: z.literal("active").describe("仅用于把已完成/已归档任务重新打开为 active；完成任务请用 task_finalize").optional(),
  })
  .strict()
  .refine((value) => value.column_id !== undefined || value.state !== undefined, {
    message: "column_id or state is required",
    path: ["column_id"],
  });

const acceptanceItemSchema = z
  .object({
    id: id.describe("checkpoint 内稳定的验收项 ID；更新同一项时保持不变"),
    statement: z.string().trim().min(1).max(400).describe("可验证的验收条件"),
    status: z.enum(["pending", "verified", "waived"]).describe("验收状态：待验证、已验证或明确豁免"),
    evidence_refs: z.array(id).max(20).describe("引用 outcome.evidence 中证据 ID；verified 项建议填写").optional(),
  })
  .strict();

const findingSchema = z
  .object({
    fact: z.string().trim().min(1).max(400).describe("已经确认的事实或根因，不写猜测和试错过程"),
    relevance: z.string().trim().min(1).max(240).describe("该事实为何会影响此 checkpoint 的判断或方案"),
  })
  .strict();

const constraintSchema = z
  .object({
    rejected_option: z.string().trim().min(1).max(300).describe("被排除的方案；只有失败原因已经验证、未来需要避免时才记录"),
    verified_reason: z.string().trim().min(1).max(400).describe("经验证的失败原因，不记录未经证实的猜测"),
    scope: z.string().trim().min(1).max(240).describe("约束适用范围，避免把局部失败误写成全局结论"),
    impact: z.string().trim().min(1).max(300).describe("该约束对后续设计或实施的实际影响"),
    evidence_refs: z.array(id).min(1).max(20).describe("支持此约束的 evidence ID，至少一项"),
    reconsider_when: z.string().trim().min(1).max(240).describe("哪些前提改变后可以重新评估该方案；无明确条件可省略").optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    id: id.describe("checkpoint 内稳定的证据 ID，供验收项和约束引用"),
    type: evidenceType,
    statement: z.string().trim().min(1).max(400).describe("证据证明了什么；写结论，不粘贴完整日志"),
    ref: z.string().trim().min(1).max(1_000).describe("可选引用，例如文件路径、测试名、URL、提交 ID 或富内容块 ID").optional(),
  })
  .strict();

const checkpointCoreInputSchema = z
  .object({
    title: z.string().trim().min(2).max(40).describe("子任务/checkpoint 标题，2–40 字；描述可独立验收的工作单元"),
    kind: z
      .enum(["analysis", "decision", "implementation", "incident", "operation"])
      .describe("内置校验类型：分析、决策、实施、故障处理或操作；只影响校验，不改变文档格式，也不是看板任务类型"),
    status: z
      .enum(["active", "blocked", "done", "cancelled", "superseded"])
      .describe("checkpoint 状态：进行中、受阻、完成、取消或被替代"),
    objective: z
      .object({
        statement: z.string().trim().min(1).max(600).describe("本 checkpoint 要解决的问题或要交付的结果"),
        acceptance: z.array(acceptanceItemSchema).min(1).max(5).describe("本 checkpoint 的可验证验收条件，1–5 项"),
      })
      .strict()
      .describe("文档中的“目标与验收”"),
    judgment: z
      .object({
        facts: z.array(findingSchema).max(4).describe("已确认事实/根因，最多 4 项；不要记录临时猜测").optional(),
        decisions: z.array(z.string().trim().min(1).max(400)).max(3).describe("已经定案且影响后续的决定，最多 3 项").optional(),
        constraints: z.array(constraintSchema).max(3).describe("由已验证失败方案形成的永久约束，最多 3 项；普通试错不要写入").optional(),
      })
      .strict()
      .describe("文档中的“关键判断”；没有长期结论时可以省略")
      .optional(),
    outcome: z
      .object({
        summary: z.string().trim().min(1).max(800).describe("实际实施结果或分析结论；写已经发生且可复核的结果"),
        evidence: z.array(evidenceSchema).max(5).describe("支持结果的关键证据，最多 5 项；大型矩阵/日志应放 rich block"),
        residual_risks: z.array(shortText).max(3).describe("完成后仍存在且值得后续知道的风险，最多 3 项").optional(),
      })
      .strict()
      .describe("文档中的“结果与证据”；done 状态必填")
      .optional(),
    blocker: z.string().trim().min(1).max(400).describe("已确认的阻塞原因；status=blocked 时必填").optional(),
    unblock_condition: z.string().trim().min(1).max(400).describe("恢复工作的明确条件；status=blocked 时必填").optional(),
    cancellation: z
      .object({
        reason: z.string().trim().min(1).max(400).describe("取消原因"),
        disposition: z.string().trim().min(1).max(400).describe("已有产物、结论或后续工作的处置方式"),
      })
      .strict()
      .describe("取消说明；status=cancelled 时必填")
      .optional(),
    superseded_by: id.describe("替代此 checkpoint 的另一个 checkpoint ID；status=superseded 时必填").optional(),
  })
  .strict()
  .describe("一个可独立验收的子任务核心；工具会按统一版式渲染，而不是追加自由 Markdown");

export const taskCheckpointCommitInputSchema = z
  .object({
    schema_version: z.literal(1).describe("写入契约版本；当前固定为 1"),
    request_id: requestId,
    task_id: id.describe("所属任务 ID"),
    checkpoint_id: id.describe("checkpoint ID；创建时省略，完整替换已有 checkpoint 时必填").optional(),
    expected_revision: revision,
    trigger: z.enum([
      "subtask_started",
      "subtask_completed",
      "decision_finalized",
      "constraint_confirmed",
      "partial_result_confirmed",
      "result_verified",
      "blocker_confirmed",
      "correction",
    ]).describe("提交原因：子任务开始/完成、决策定案、约束确认、部分结果确认、结果验证、阻塞确认或纠正"),
    core: checkpointCoreInputSchema.describe("完整的 checkpoint 新状态；更新为全量替换，不是增量 append"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expected_revision > 0 && value.checkpoint_id === undefined) {
      context.addIssue({ code: "custom", path: ["checkpoint_id"], message: "updates require checkpoint_id" });
    }
    if (value.core.status === "done" && value.core.outcome === undefined) {
      context.addIssue({ code: "custom", path: ["core", "outcome"], message: "done checkpoints require outcome" });
    }
    if (value.core.status === "blocked" && (value.core.blocker === undefined || value.core.unblock_condition === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["core", "blocker"],
        message: "blocked checkpoints require blocker and unblock_condition",
      });
    }
    if (value.core.status === "cancelled" && value.core.cancellation === undefined) {
      context.addIssue({ code: "custom", path: ["core", "cancellation"], message: "cancelled checkpoints require cancellation" });
    }
    if (value.core.status === "superseded" && value.core.superseded_by === undefined) {
      context.addIssue({ code: "custom", path: ["core", "superseded_by"], message: "superseded checkpoints require superseded_by" });
    }
  });

const blockKind = z.enum([
  "data_table",
  "mermaid",
  "domain_checklist",
  "code_or_config",
  "test_evidence",
  "technical_spec",
  "source_reference",
]).describe("富内容类型：数据表、Mermaid、领域清单、代码/配置、测试证据、技术规格或来源引用");

export const taskBlockPutInputSchema = z
  .object({
    schema_version: z.literal(1).describe("写入契约版本；当前固定为 1"),
    request_id: requestId,
    task_id: id.describe("所属任务 ID"),
    checkpoint_id: id.describe("所属 checkpoint ID"),
    block_id: id.describe("富内容块 ID；创建时省略，完整替换已有块时必填").optional(),
    expected_revision: revision,
    block: z
      .object({
        kind: blockKind,
        title: z.string().trim().min(2).max(80).describe("富内容块标题，显示在 checkpoint 的“详细资料”清单中"),
        summary: z.string().trim().min(10).max(240).describe("这份资料包含什么、为何值得保留；不要只写“见附件”"),
        supports: z.enum(["objective", "judgment", "outcome"]).describe("该块支持核心中的目标、关键判断还是结果与证据"),
        checklist_scope: z
          .enum(["acceptance", "compatibility", "deployment", "test_matrix", "production_check"])
          .describe("领域清单用途；kind=domain_checklist 时必填")
          .optional(),
        source_uri: z.string().trim().min(1).max(1_000).describe("来源 URI/文件路径；kind=source_reference 时必填").optional(),
        language: z.string().trim().min(1).max(40).describe("代码或配置语言，例如 json、yaml、powershell；kind=code_or_config 时必填").optional(),
        content: z.string().min(1).max(200_000).describe("完整 Markdown/文本内容；支持表格、Mermaid 和大型清单，实际上限由插件设置进一步约束"),
      })
      .strict()
      .describe("与核心分离的可寻址长期资料；大内容放这里，不要塞进 checkpoint core"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expected_revision > 0 && value.block_id === undefined) {
      context.addIssue({ code: "custom", path: ["block_id"], message: "updates require block_id" });
    }
    if (value.block.kind === "domain_checklist" && value.block.checklist_scope === undefined) {
      context.addIssue({ code: "custom", path: ["block", "checklist_scope"], message: "domain_checklist requires checklist_scope" });
    }
    if (value.block.kind === "code_or_config" && value.block.language === undefined) {
      context.addIssue({ code: "custom", path: ["block", "language"], message: "code_or_config requires language" });
    }
    if (value.block.kind === "source_reference" && value.block.source_uri === undefined) {
      context.addIssue({ code: "custom", path: ["block", "source_uri"], message: "source_reference requires source_uri" });
    }
  });

const resumeCapsuleInputSchema = z
  .object({
    focus_checkpoint_id: id.describe("当前要接续的 active/blocked checkpoint ID"),
    based_on_revision: z.number().int().min(1).describe("接续卡所依据的 checkpoint revision；必须与当前版本一致"),
    last_verified: z.string().trim().min(1).max(400).describe("最近一个已经验证的停点；没有新验证结果可省略").optional(),
    next_action: z.string().trim().min(1).max(400).describe("新 session 应立即执行的唯一下一动作；只写一项，不写完整计划"),
    blockers: z
      .array(
        z
          .object({
            statement: z.string().trim().min(1).max(300).describe("当前阻塞事实"),
            unblock_when: z.string().trim().min(1).max(300).describe("解除阻塞的明确条件"),
          })
          .strict(),
      )
      .max(3)
      .describe("临时接续所需的阻塞项，最多 3 项；不会进入永久 checkpoint"),
    open_questions: z.array(shortText).max(3).describe("继续工作前仍需回答的问题，最多 3 项；解决后应从接续卡删除"),
    working_artifacts: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(1_000).describe("工作文件或产物路径"),
            purpose: z.string().trim().min(1).max(240).describe("该文件与当前 checkpoint 的关系"),
            state: z.enum(["editing", "changed", "verified"]).describe("文件状态：正在编辑、已修改未验证或已验证"),
          })
          .strict(),
      )
      .max(5)
      .describe("接续所需的工作文件，最多 5 项"),
    workspace_ref: z
      .object({
        repo: z.string().trim().min(1).max(1_000).describe("仓库路径或 URL").optional(),
        branch: z.string().trim().min(1).max(300).describe("当前分支名").optional(),
        commit: z.string().trim().min(1).max(128).describe("最近确认的提交 ID").optional(),
      })
      .strict()
      .describe("可选的代码工作区定位信息")
      .optional(),
  })
  .strict()
  .describe("覆盖式跨 session 接续快照；不是永久历史，不写聊天、命令日志或试错时间线");

export const taskHandoffInputSchema = z
  .object({
    schema_version: z.literal(1).describe("写入契约版本；当前固定为 1"),
    request_id: requestId,
    task_id: id.describe("要保存接续点的任务 ID"),
    expected_revision: revision,
    capsule: resumeCapsuleInputSchema.describe("新的完整接续卡，会覆盖旧值；不会创建另一张看板卡片"),
  })
  .strict();

export const taskFinalizeInputSchema = z
  .object({
    schema_version: z.literal(1).describe("写入契约版本；当前固定为 1"),
    request_id: requestId,
    task_id: id.describe("要完成或归档的任务 ID"),
    expected_revision: revision,
    status: z.enum(["done", "archived"]).describe("终态：done 表示验收完成；archived 表示停止并归档已有结果"),
    final_outcome: z.string().trim().min(1).max(1_000).describe("从已提交 checkpoint 汇总出的任务级最终结果；不写过程流水账"),
    evidence: z.array(evidenceSchema.omit({ id: true })).min(1).max(20).describe("支持最终结果的关键证据，1–20 项"),
    remaining: z.array(shortText).max(3).describe("明确未解决但需后续知道的事项，最多 3 项；没有则传空数组"),
  })
  .strict();

const structuredErrorSchema = z
  .object({
    code: z.enum([
      "INVALID_INPUT",
      "TASK_NOT_FOUND",
      "CHECKPOINT_NOT_FOUND",
      "VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "QUALITY_REJECTED",
      "DOCUMENT_CONFLICT",
      "DOCUMENT_MALFORMED",
      "IO_BUSY",
      "IO_ERROR",
      "PLUGIN_CONFIG_REQUIRED",
      "INTERNAL_ERROR",
    ]),
    message: z.string(),
    action: z.enum(["revise_input", "reread", "retry_same_request", "configure_plugin", "none"]),
    retryable: z.boolean(),
    issues: z
      .array(
        z
          .object({ path: z.string(), rule: z.string(), message: z.string() })
          .strict(),
      )
      .optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// SDK 1.x wraps raw shapes reliably but its output validator does not support a
// top-level discriminated union. The handler still enforces the ok/data vs
// ok/error invariant when constructing results.
export const toolResultOutputSchema = z
  .object({
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: structuredErrorSchema.optional(),
  })
  .strict();

export type TaskCatalogInput = z.infer<typeof taskCatalogInputSchema>;
export type TaskQueryInput = z.infer<typeof taskQueryInputSchema>;
export type TaskResumeInput = z.infer<typeof taskResumeInputSchema>;
export type TaskReadInput = z.infer<typeof taskReadInputSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
export type TaskCardUpdateInput = z.infer<typeof taskCardUpdateInputSchema>;
export type TaskCheckpointCommitInput = z.infer<typeof taskCheckpointCommitInputSchema>;
export type TaskBlockPutInput = z.infer<typeof taskBlockPutInputSchema>;
export type TaskHandoffInput = z.infer<typeof taskHandoffInputSchema>;
export type TaskFinalizeInput = z.infer<typeof taskFinalizeInputSchema>;
