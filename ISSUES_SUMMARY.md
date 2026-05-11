# Memory Governor Pro 问题总结

日期：2026-04-28

本文档汇总 `memory-governor-pro` 当前已经发现的缺口、风险和疑似问题。结论来自代码阅读、当前 `openclaw.json` 配置检查，以及非破坏性的黑盒测试。

## 总览

核心 Governor 管线在隔离环境中可以正常工作：它能够归档现有会话 JSONL 文件，将消息精炼为治理记忆，创建单个空的活跃 JSONL，同步 `sessions.json`，写入审计记录，并从治理记忆生成注入包。

当前主要问题包括：

- 真实 `main` 会话目录尚未收敛为单个活跃 JSONL。
- 部分文档和配置仍描述旧版轮转行为。
- 治理精炼和治理检索目前偏轻量，召回质量可能有噪声。
- 回滚/审计工具仍混杂旧的 snapshot 思路和新的 `governor-full` 归档路径。
- 部分在线运行链路尚未完整验证，因为它们依赖真实 OpenClaw 网关和外部 API。

## 1. 真实会话目录未完全收敛

### 现象

分层注入校验显示：`sessions.json` 的会话文件指针已经统一，但 `agents/main/sessions` 目录下仍存在多个活跃 `*.jsonl` 文件。

观察到的活跃文件：

- `3b859cd7-c352-4b5c-9331-b516b182f7c2.jsonl`
- `827ffa87-62e6-4295-89b8-b18cd2435967.jsonl`
- `bb25edef-0c59-4514-b236-49db5f85c3ba.jsonl`
- `cceb16c3-b2cc-46b8-b9d5-8817017f521c.jsonl`

### 影响

插件预期的 full-strip 后状态是：原始会话进入归档目录，活跃会话目录只保留一个新的空 JSONL。多个活跃 JSONL 会干扰后续扫描、清理、审计和上下文压力判断。

### 可能原因

- 历史文件在某次清理后残留。
- `first-install-bootstrap.json` 已经标记首次回填完成，内部调度器不会自动再次执行首次 full-strip。
- 后续 OpenClaw 会话操作又创建了新的活跃文件。

### 建议修复

执行受控清理流程：

1. 先备份 `agents/main/sessions`。
2. 检查当前 `sessions.json` 和各 JSONL 文件大小。
3. 优先使用 dry-run 或受控 full-strip 路径处理。
4. 最后确认目录中只剩一个活跃 `*.jsonl`。

不要手工删除会话文件，除非已经确认内容已归档或确实无效。

## 2. `first-install-bootstrap.json` 阻止首次回填自动重跑

### 现象

已存在：

```text
skills/memory-governor-pro/state/main/first-install-bootstrap.json
```

### 影响

内部调度器会认为首次安装回填已经完成，因此不会自动修复后续出现的非收敛会话目录。

### 建议修复

如果需要重新执行首次 full-strip，建议先使用现有回滚/重置流程检查，而不是直接删除标记文件。

可先执行 dry-run：

```bash
npm run governor:rollback-first-install -- --agent main --dry-run
```

## 3. 当前只有 `main` 启用 Governor

### 现象

当前 `openclaw.json` 中只有：

```json
"governor": {
  "enabledAgents": ["main"]
}
```

### 影响

`xunc1`、`xunc2` 等 agent 不会参与首次 full-strip、阈值 flush 或 Governor 维护。

### 建议修复

如果这些 agent 也需要长期记忆治理，应显式加入：

```json
"enabledAgents": ["main", "xunc1", "xunc2"]
```

修改后先做非破坏性验证，再重启网关。

## 4. `rotateOnAgentEnd` 配置已过时

### 现象

`config.json` 中仍有：

```json
"rotateOnAgentEnd": true
```

但当前 README 和代码逻辑已经说明：每轮任务结束自动轮转不再是主链路。

### 影响

该配置会误导维护者，以为每次 `agent_end` 都会执行会话轮转。当前实际主链路是首次 full-strip、上下文阈值 full-strip、归档 TTL 和手动 CLI 操作。

### 建议修复

在 `config.json`、`SKILL.md` 和 README 中删除或明确标记 `rotateOnAgentEnd` 为废弃/忽略项。

## 5. `SKILL.md` 描述了旧行为

### 现象

`SKILL.md` 仍描述了：

- 每日 24:00 任务。
- 50/70/85 上下文阈值任务。
- 每次 `agent_end` 后轮转。
- 每轮结束后会话目录归一化。

### 影响

文档与当前实现不一致。维护者可能期待某些自动行为，但实际不会发生，容易造成误判。

### 建议修复

将 `SKILL.md` 更新为当前生命周期：

- 内部调度器：首次 full-strip + 归档 TTL。
- 上下文 flush：阈值触发 full-strip。
- CLI rotate：应急/手动工具，不是主要运行时链路。
- 单一注入器：通过合并后的 `before_prompt_build` 注入。

## 6. 文档和默认字符串存在中文乱码

### 现象

多个中文字符串出现 mojibake 乱码，例如：

- `杩戞湡鍐崇瓥涓庣‖绾︽潫`
- README / SKILL 中大量中文乱码。

### 影响

乱码默认查询会降低治理检索质量；乱码文档也会增加维护和排障难度。

### 建议修复

统一将仓库文本文件修复为 UTF-8，并把乱码字面量替换为正确中文。例如：

```text
近期决策与硬约束
```

修复后重新运行配置校验和注入包测试。

## 7. 治理精炼逻辑偏规则化，容易产生噪声

### 现象

Governor 的 refiner 主要按单条消息和正则规则处理。在真实 `build-pack` 输出中，曾召回类似寒暄或助手确认语的低价值内容。

### 影响

治理记忆可能累积低价值内容，占用注入预算，降低真正约束、决策和风险的信号密度。

### 建议修复

在 `upsertMemories` 前增加更强过滤：

- 过滤寒暄和助手模板化回复。
- 治理事实优先来自用户消息；助手消息只有包含明确决策、结果或约束时才保留。
- 增加最低信号阈值。
- 如果已配置 LLM，可考虑为 Governor 条目增加可选 LLM 精炼。

## 8. 治理库使用伪 embedding

### 现象

`src/lib/lancedbStore.ts` 中治理记忆使用 `pseudoEmbedding()`，没有使用主记忆配置的真实 embedding provider。

### 影响

治理检索并不是真正语义检索，更多依赖宽松词项重合。对中文复杂语义查询可能漏召回，也可能因为表面词重合而误召回。

### 建议修复

二选一：

- 保留伪 embedding，但在文档中明确说明限制。
- 或将治理记忆写入改为使用主记忆同款真实 embedder，并为已有治理库提供迁移方案。

## 9. 新 full-strip 审计路径与旧 snapshot 工具混杂

### 现象

新的 full-strip 流程主要写入：

- `state/<agent>/audit.jsonl`
- `agents/<agent>/sessions/archive/governor-full/<runId>/...`

但部分 CLI、审计和回滚文案仍围绕旧路径：

- `state/<agent>/snapshots/<date>.json`
- 按日期 rotation record。

### 影响

维护者可能运行审计/回滚命令后看到“无轮转记录”，但实际上可能曾经通过新 full-strip 路径执行过治理。这会增加恢复难度。

### 建议修复

围绕当前 full-strip 模型统一审计工具：

- 增加 `governor-full` run 检查能力。
- 增加从 `governor-full` 恢复的命令或明确文档。
- 将旧 snapshot 命令明确标为 legacy-only。

## 10. `archive-prune` 跳过 `governor-full`

### 现象

dry-run 输出中显示：

```json
"skippedEntries": ["governor-full"]
```

### 影响

full-strip 归档可能长期累积，占用磁盘空间。

### 建议修复

为 `archive/governor-full/<runId>` 增加独立保留策略。默认策略应保守，并强制支持 dry-run。

## 11. 在线运行 hook 尚未完整黑盒验证

### 尚未完整验证的链路

- `message_received` 在线快速 auto-capture。
- `agent_end` 后台智能抽取。
- `before_prompt_build` 在真实 OpenClaw 模型调用中的合并注入。
- 上下文压力触发 full-strip 后的自动续跑。

### 原因

这些链路需要运行中的 OpenClaw 网关、真实消息事件和外部 embedding/LLM 调用。本次测试避免消耗真实 API key，也避免污染生产记忆库。

### 建议修复

创建专用测试 agent 和测试 OpenClaw home，使用本地或 dummy embedding/LLM provider，编写完整端到端网关测试。

## 12. LLM 智能抽取尚未完整验证

### 现象

当前配置开启了 `smartExtraction`，但本次测试没有调用外部 LLM 抽取路径。

### 影响

profile、preferences、entities、events、cases、patterns 等结构化抽取质量尚未确认。

### 建议修复

在临时数据库中做受控抽取测试：

- 用户偏好声明。
- 项目决策。
- 实体关系。
- 矛盾或 supersede 场景。
- 低价值对话，应不产生记忆。

验证 created、merged、skipped 计数以及 metadata 内容。

## 13. OpenClaw CLI wrapper 在沙盒用户下失败

### 现象

以下命令在 Codex 沙盒用户下失败：

```bash
openclaw memory-pro stats
openclaw memory-pro list --limit 3
```

原因是 Node 尝试 `lstat C:\Users\hcls-f9` 时收到 `EPERM`。

### 影响

这不能证明插件 CLI 在真实 Windows 用户下有问题，但会阻止从沙盒环境完整验证 OpenClaw wrapper 层。

### 建议修复

在真实用户终端中直接运行这些命令。如果真实用户终端也失败，再检查全局 `openclaw.ps1` 启动器和 Node 路径解析。

## 14. API Key 明文存储

### 现象

`openclaw.json` 中存在 embedding、rerank 和 LLM provider 的明文 API key。

### 影响

配置文件被分享、截图、备份或提交时，密钥容易泄露。

### 建议修复

改用环境变量引用：

```json
"apiKey": "${JINA_API_KEY}"
```

并在配置文件之外管理环境变量。

## 15. `.tmp` 下残留测试产物

### 现象

黑盒测试创建了临时目录：

```text
.openclaw/.tmp/mgp-blackbox-*
```

### 影响

这些目录是隔离测试产物，通常无害，但会占用磁盘空间。

### 建议修复

确认不再需要后可以删除。

## 已验证可工作的行为

以下行为已在隔离黑盒测试中验证：

- full-strip 返回成功。
- 会话文件被归档到 `archive/governor-full/<runId>`。
- 活跃会话目录被收敛为一个 JSONL。
- `sessions.json` 条目被统一指向 keeper JSONL。
- 治理记忆行被写入。
- `buildInjectionPack` 可以检索相关治理行并输出 TOON。
- `archive-prune --dry-run` 不会删除数据。
- `flush --percent 10` 低于阈值时不会触发。

## 建议处理优先级

1. 安全收敛真实 `main` 会话目录。
2. 修正文档和配置中关于轮转行为的漂移。
3. 修复中文乱码。
4. 增强治理噪声过滤。
5. 为 `governor-full` 归档增加保留策略。
6. 围绕 `audit.jsonl` 和 `governor-full` 统一审计/回滚命令。
7. 构建临时完整网关端到端测试，覆盖 auto-capture 和 auto-recall。
