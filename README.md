# memory-governor-pro

[中文](#中文文档) | [English](#english-documentation)

一个一体化的 OpenClaw 记忆工程项目，包含：

- **长期记忆插件**（`memory-lancedb-pro`）
- **Governor 治理管道**（日常 / 阈值 / 审计 / 回滚）
- **随仓分发的自改进技能资源**（`bundled/self-improvement`）

> 面向长周期运行的 agent 设计，强调记忆连续性稳定、审计可追溯，以及低上下文预算下的高质量注入。

---

## 中文文档

### 目录

- [核心功能](#核心功能通俗版)
- [项目来源与借鉴](#项目来源与借鉴)
- [设计思路](#设计思路)
- [快速开始](#快速开始)
- [项目简介](#项目简介)
- [架构说明](#架构说明)
- [完整配置示例](#完整配置示例)
- [配置项详解](#配置项详解)
- [常用命令](#常用命令)
- [运维与排障](#运维与排障)
- [FAQ](#faq)
- [许可证](#许可证)

### 快速导航（优先阅读）

1. **功能介绍**：先看 [核心功能（通俗版）](#核心功能通俗版)  
2. **借鉴项目**：再看 [项目来源与借鉴](#项目来源与借鉴)  
3. **实现思路**：然后看 [设计思路](#设计思路)  
4. **如何使用**：最后看 [快速开始](#快速开始) 和 [完整配置示例](#完整配置示例)

### 核心功能

如果把一个长期运行的 agent 比作“一个需要持续交付的同事”，这个项目做的事情可以概括为：

1. **让它记得住**  
   普通会话容易“聊久就忘”。本项目把关键信息写入向量记忆库，不再只依赖当前对话窗口。

2. **让它记得准**  
   不是把历史原文全部塞进上下文，而是分层注入：  
   - 自改进规则（最宽松命中，保证规范不丢）  
   - 主记忆（保持 memory-lancedb-pro 原有稳定召回）  
   - 治理记忆（最严格过滤，减少噪声）  
   用最短上下文放最关键信息。

3. **让长任务不中断思路**  
   当上下文接近压缩/预算上限时触发**阈值全量剥皮**（入库 → 归档副本 → 腾空会话 → 生成注入包）；精炼与「每轮聊天结束」**解耦**，日常对话可一直保留在会话文件中直到阈值触发。  
   触发后会记录中断状态（会话/指令来源/最近任务意图），在精炼完成后的下一次 prompt 构建自动注入恢复块，再继续原任务目标。

4. **让行为可审计、可回滚**  
   关键步骤写入 `state/<agent>/audit.jsonl`；全量剥皮前的会话整文件副本在 `agents/<agent>/sessions/archive/governor-full/<时间戳>/`。（CLI `nightly` / `daily-rotate` 路径不再写入 `state/.../snapshots/<日>.json`。）

5. **让会话目录在剥皮后极简**  
   **首装**与**阈值**成功后：`sessions` 下仅保留**一个空的**活跃 `*.jsonl`，`sessions.json` 中所有条目会**强制对齐**到该文件。

一句话：**用更短上下文，保留更完整有效记忆，并把长周期稳定性问题变成可治理、可追踪的工程能力。**

### 项目来源与借鉴

本项目明确借鉴并扩展了以下开源工作：

- [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)  
  用于长期记忆、混合检索、OpenClaw 插件集成主链路。
- [pskoett-ai-skills / self-improvement](https://github.com/pskoett/pskoett-ai-skills/tree/main/skills/self-improvement)  
  用于自改进规则工作流与 `.learnings` 资产组织方式。

> 本仓库不是上游仓库 1:1 镜像，以本仓代码和文档为准。

### 设计思路

#### 1) 分层数据面

- **主记忆库**：面向在线对话，存“可被直接召回”的记忆  
- **治理记忆库**：面向精炼和长期留存，存“会话治理条目”  
- **归档会话文件**：面向审计与回滚，运行时不直接依赖

#### 2) 分层注入面（最短上下文 + 最全有效输入）

- `self-improvement`：最宽松（规则关键词触发）
- `memory-lancedb-pro`：中等（保持原召回策略）
- `governance`：最严格（高约束、低配额）

#### 3) 生命周期治理面（Governor）

- **首次安装**：根据 `state/<agent>/first-install-bootstrap.json` 判断是否执行；对当前全部会话转录**按日历桶精炼入治理向量库**，再整文件复制到 `archive/governor-full/<runId>/`，删除原转录并生成**唯一空 jsonl**，同步 `sessions.json`。可选 `internalScheduler.openclawCleanup` 在收尾执行 `openclaw sessions cleanup`。  
- **阈值精炼**：在 `before_prompt_build` 与定时扫描上，当用量达到 `contextFlush` 配置（提前量可调）时，执行同一套**全量剥皮**，成功后按现有逻辑 `buildInjectionPack`（`context-pack.md`）。精炼成功后会写入 `state/<agent>/context-flush-resume.json`，并在后续构建时注入恢复状态。**不再**在「每轮任务结束」自动剥皮。  
- **日终按日轮转**：已从新主链路移除；网关内调度仅保留**首装**与**归档 TTL**（删除 `archive` 下过期 **YYYY-MM-DD** 形目录）。手工 `npm run governor:daily-rotate` 等仍可作为抢险工具。  
- 操作痕迹以 **`audit.jsonl`** 为主，不再依赖 `snapshots/<日>.json` 作为 Governor 主路径产物。

### 快速开始

#### 1) 安装依赖

```bash
#进入插件目录
cd /path/to/memory-governor-pro
npm install
```

#### 2) 设置环境变量（示例）


Linux/macOS:

```bash
#也可以使用env文件存放
export OPENCLAW_HOME="$HOME/.openclaw"
export JINA_API_KEY="your_key"
```

Windows PowerShell:

```powershell
#也可以使用env文件存放
$env:OPENCLAW_HOME="$env:USERPROFILE\.openclaw"
$env:JINA_API_KEY="your_key"
```

#### 2.5) OpenClaw 网关：Web 聊天记录字符预算（推荐）

本插件**不修改** OpenClaw 本体；若使用 **OpenClaw Control 网页聊天**，网关会通过 `chat.history` 下发历史，并对单条文本按 `gateway.webchat.chatHistoryMaxChars` 截断（未配置时默认较小）。  
当 user 消息前有较长的系统/自改进等前缀时，**真实指令在末尾**，截断可能导致控制台里「刷新后看不到刚发的短句」，而磁盘上的 `*.jsonl` 仍完整。

可在 **`openclaw.json` 的 `gateway` 下**增加（数值可按机器与官方 schema 上限调整）：

```json
"webchat": {
  "chatHistoryMaxChars": 200000
}
```

保存后执行 `openclaw config validate` 与 `openclaw gateway restart`。  
**说明**：这是 OpenClaw 官方配置项，属于部署侧建议，不是插件对核心的补丁；若需「超长 user 始终保留尾部」等行为，只能依赖 **上游 OpenClaw 版本演进** 或自行 fork，无法仅靠本 skill 源码替代网关实现。

#### 3) 安装 skill 到 OpenClaw

```bash
#最后的main与xunc1替换为自身的agentid
node scripts/manage-plugin-install.mjs install --agents main,xunc1
```

#### 4) 校验与重启

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
```

#### 5) 运行健康检查

```bash
npm run governor:verify-layered-injection
npm run governor:test-full-strip
```

### 项目简介

`memory-governor-pro` 是一个一体化 skill，目标是解决三类问题：

1. **长期记忆可用性**：会话内容可持续沉淀并可检索注入。  
2. **长周期任务稳定性**：在上下文压力下仍能保持任务连续性。  
3. **治理可审计可回滚**：所有精炼、归档、清理行为可追踪可恢复。

### 架构说明

| 组件 | 入口 | 主要职责 |
|---|---|---|
| 插件 | `index.ts`, `openclaw.plugin.json` | 记忆读写、自动捕获/召回、三源注入编排 |
| Governor CLI | `src/index.ts`, `config.json` | 精炼、归档、回填、审计、回滚 |
| 自改进资源 | `bundled/self-improvement/` | 规则模板、脚本、学习资产 |
| 治理库适配 | `src/lib/lancedbStore.ts` | 治理向量库写入/严格检索 |
| 注入编排 | `src/lib/unified-injection.ts` | 分层预算与候选裁剪 |

### 完整配置示例

> 以下示例展示常用生产配置（含三层注入预算、内部调度首装、阈值上下文卸载）。`rotateOnAgentEnd` 已废弃（插件忽略）。

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-lancedb-pro"
    },
    "load": {
      "paths": [
        "skills/memory-governor-pro"
      ]
    },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${JINA_API_KEY}",
            "baseURL": "https://api.jina.ai/v1",
            "model": "jina-embeddings-v3"
          },
          "retrieval": {
            "mode": "hybrid",
            "vectorWeight": 0.7,
            "bm25Weight": 0.3,
            "minScore": 0.3,
            "rerank": "cross-encoder",
            "rerankProvider": "jina",
            "rerankApiKey": "${JINA_API_KEY}",
            "rerankEndpoint": "https://api.jina.ai/v1/rerank",
            "rerankModel": "jina-reranker-v2-base-multilingual",
            "candidatePoolSize": 60
          },
          "autoCapture": true,
          "autoRecall": true,
          "autoRecallMaxItems": 4,
          "autoRecallMaxChars": 900,
          "autoRecallPerItemMaxChars": 220,
          "recallMode": "adaptive",
          "smartExtraction": true,
          "extractMinMessages": 4,
          "extractMaxChars": 8000,
          "sessionStrategy": "memoryReflection",
          "enableManagementTools": true,
          "governor": {
            "enabledAgents": ["main", "xunc1"],
            "runtimeVectorOnlyRecall": true,
            "injectionLayerBudget": {
              "selfImprovement": 0.2,
              "memory": 0.5,
              "governance": 0.3
            },
            "internalScheduler": {
              "enabled": true,
              "tickIntervalMs": 600000,
              "firstInstallBackfillEnabled": true,
              "openclawCleanup": false
            }
          }
        }
      }
    }
  }
}
```

### 配置项详解

#### A. 插件核心

| 配置 | 说明 | 建议 |
|---|---|---|
| `embedding.provider` | 嵌入服务协议（OpenAI 兼容） | 固定 `openai-compatible` |
| `embedding.apiKey` | 嵌入 API 密钥（可 `${ENV}`） | 放环境变量 |
| `embedding.baseURL` | 嵌入服务地址 | 与 provider 对齐 |
| `embedding.model` | 向量模型 | 统一全局模型，避免维度漂移 |
| `dbPath` | 主记忆库路径 | 不与治理库复用 |

#### B. 检索与注入

| 配置 | 说明 | 建议 |
|---|---|---|
| `retrieval.mode` | `hybrid`/`vector` | 生产建议 `hybrid` |
| `vectorWeight`/`bm25Weight` | 混合权重 | 0.7/0.3 起步 |
| `rerank*` | 重排配置 | 强相关场景建议启用 |
| `autoRecall` | 自动注入开关 | 长任务建议开启 |
| `autoRecallMaxItems` | 单轮注入条数上限 | 3-6 |
| `autoRecallMaxChars` | 单轮注入总字符预算 | 600-1200 |
| `recallMode` | full/summary/adaptive/off | 推荐 `adaptive` |

#### C. 抽取与压缩

| 配置 | 说明 | 建议 |
|---|---|---|
| `autoCapture` | 自动抓取会话记忆 | 建议开启 |
| `smartExtraction` | LLM 结构化抽取 | 建议开启 |
| `extractMinMessages` | 触发抽取最少消息数 | 4 |
| `extractMaxChars` | 抽取输入最大字符 | 8000 |
| `sessionCompression.enabled` | 抽取前压缩 | 高并发时建议开启 |

#### D. Governor 扩展

| 配置 | 说明 | 建议 |
|---|---|---|
| `governor.enabledAgents` | 启用管家（首装 + 阈值作用域）的 agent；空数组则内部调度不跑首装 | 明确列出 |
| `runtimeVectorOnlyRecall` | 运行时只读向量库，不回读会话文件 | `true` |
| `injectionLayerBudget` | 三层注入预算（SI/Memory/Governance） | 0.2/0.5/0.3 |
| `internalScheduler.enabled` | 内建调度（首装一次尝试 + 归档 TTL） | `true` |
| `internalScheduler.tickIntervalMs` | 心跳间隔；日终轮转已移除，可适当拉大（如 10 分钟） | 60000+ |
| `internalScheduler.firstInstallBackfillEnabled` | 是否启用首装全量剥皮 | `true` |
| `internalScheduler.openclawCleanup` | 首装成功后是否执行 `openclaw sessions cleanup` | 按需 |
| `contextFlush.*` | 阈值触发线、轮询间隔、`query`（注入包检索主题）等 | 见 `config.json` |
| ~~`rotateOnAgentEnd`~~ | **已废弃**（插件不再注册任务结束剥皮） | 可删除 |
| `firstInstallBackfillMaxDays` | 历史仅保留兼容字段；新首装为**全量**会话剥皮，不按「最多历史日」截断 | — |

#### E. 路径隔离（非常重要）

| 项 | 路径 | 要点 |
|---|---|---|
| 主记忆库 | `plugins.entries.memory-lancedb-pro.config.dbPath` | 在线召回主来源 |
| 治理记忆库 | `config.json -> lancedb.dbPath` | 治理专用，严禁复用主库 |
| 会话归档 | `agents/<agent>/sessions/archive/` | 旧版按日归档；**全量剥皮**副本在 `archive/governor-full/<时间戳>/` |

### 常用命令

#### memory-pro

```bash
openclaw memory-pro list
openclaw memory-pro search "keyword"
openclaw memory-pro stats
openclaw memory-pro export --output memories.json
openclaw memory-pro import memories.json
```

#### Governor

```bash
npm run governor:daily-rotate
npm run governor:daily-rotate:all-agents
npm run governor:bootstrap
npm run governor:flush
npm run governor:governance
npm run governor:audit-inspect
npm run governor:audit-restore
npm run governor:audit-clear-rotation
npm run governor:audit-purge-memories
npm run governor:rollback-first-install
npm run governor:archive-prune
npm run governor:verify-layered-injection
```

### 运维与排障

- **无注入内容**：检查 `autoRecall`、`recallMode`、`dbPath`、API Key。  
- **治理注入过多**：提高严格阈值/降低治理预算。  
- **双提醒注入**：避免重复启用 self-improvement hook 与插件提醒。  
- **库冲突**：确保主库与治理库路径隔离。  
- **上下文仍膨胀**：降低 `autoRecallMaxChars`，并开启 `runtimeVectorOnlyRecall`。  

### FAQ

**Q1: 为什么要分主库和治理库？**  
A: 主库服务在线召回，治理库服务精炼审计与长期留存，分离后稳定性更高。  

**Q2: 会话文件还会保留吗？**  
A: **运行中**原文在 `sessions/*.jsonl`；首装或阈值剥皮后，目录里只留**空**的活跃文件，原文在 `archive/governor-full/<时间戳>/`；运行时注入仍以向量库为主（配合 `context-pack` 等）。

**Q3: 如何回滚「首次安装自动回填」？**  
A: 在 skill 根目录执行 `npm run governor:rollback-first-install`。`rotatedDateKeysAsc` 仍写在 `first-install-bootstrap.json`。新版主链路以 **`archive/governor-full/`** 与 **`audit.jsonl`** 为主要人工依据；若回滚流程仍引用 `snapshots/<日>.json` 而未被 CLI 生成，需结合归档副本处理。**建议先 `--dry-run`**；多 agent 使用 `--all-governor-agents`；见子命令 `--help`。

示例（在 `memory-governor-pro` 目录下）：

```bash
npm run governor:rollback-first-install -- --agent main --dry-run
npm run governor:rollback-first-install -- --all-governor-agents
npm run governor:rollback-first-install -- --agent main --dates 2025-03-01,2025-03-02
```

**Q4: 能否按 agent 精细化配置？**  
A: 可以，通过 `enabledAgents` 和 agent override 文件实现。  

### 许可证

MIT

---

## English Documentation

### Table of Contents

- [Features](#features)
- [Inspirations and Credits](#inspirations-and-credits)
- [Design Principles](#design-principles)
- [Getting Started](#getting-started)
- [Overview](#overview)
- [Architecture](#architecture)
- [Full Configuration Example](#full-configuration-example)
- [Configuration Reference](#configuration-reference)
- [Commands](#commands)
- [Operations and Troubleshooting](#operations-and-troubleshooting)
- [FAQ](#faq-1)
- [License](#license)

### Start Here (Read First)

1. **Feature Overview**: [Features](#features)  
2. **Project Inspirations**: [Inspirations and Credits](#inspirations-and-credits)  
3. **Implementation Idea**: [Design Principles](#design-principles)  
4. **How to Use**: [Getting Started](#getting-started) and [Full Configuration Example](#full-configuration-example)

### Overview

`memory-governor-pro` is an integrated OpenClaw skill suite that combines:

- Long-term memory plugin (`memory-lancedb-pro`)
- Governor governance pipeline (rotation, flush, rollback, audit)
- Bundled self-improvement assets (`bundled/self-improvement`)

It is designed for long-running agents that require memory continuity with strict auditing and compact prompt injection.

### Inspirations and Credits

This project builds upon and extends:

- [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)
- [pskoett-ai-skills / self-improvement](https://github.com/pskoett/pskoett-ai-skills/tree/main/skills/self-improvement)

This repository is not a 1:1 mirror of upstream projects. The code and docs here are the source of truth.

### Features

- Hybrid long-term memory retrieval and management tools
- Auto-capture and auto-recall with dedup and governance filters
- Layered injection strategy:
  - permissive self-improvement rule hits
  - unchanged memory-lancedb-pro recall
  - strict governance retrieval
- First-install **full strip** (ingest → `archive/governor-full/<runId>/` → single empty jsonl → `sessions.json` sync)
- **Threshold** full strip on context pressure, then `buildInjectionPack` (same hook as before)
- No nightly day-by-day rotation in the gateway scheduler (TTL + first-install only); CLI rotate remains for emergencies
- `audit.jsonl` as the primary Governor audit trail (CLI `nightly` no longer writes `state/.../snapshots/<day>.json`)

### Design Principles

1. **Separation of concerns**
   - runtime memory store vs governance memory store
2. **Layered injection**
   - strict budgeted orchestration across memory sources
3. **Audit-first governance**
   - full-strip runs append to `audit.jsonl`; session copies live under `governor-full` archives
4. **Context efficiency**
   - shortest practical prompt context with maximal useful recall

### Architecture

| Component | Entry | Responsibility |
|---|---|---|
| Plugin | `index.ts` | recall/capture/injection orchestration |
| Governor CLI | `src/index.ts` | rotate/flush/backfill/audit/rollback |
| Self-improvement assets | `bundled/self-improvement` | rules, templates, helper scripts |
| Governance store adapter | `src/lib/lancedbStore.ts` | strict governance retrieval |

### Getting Started

```bash
cd /path/to/memory-governor-pro
npm install
```

Set environment variables (example):

```bash
export OPENCLAW_HOME="$HOME/.openclaw"
export JINA_API_KEY="your_key"
```

Install:

```bash
node scripts/manage-plugin-install.mjs install --agents main,xunc1
```

Validate and restart:

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
```

Verify layered setup:

```bash
npm run governor:verify-layered-injection
npm run governor:test-full-strip
```

### Full Configuration Example

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "autoCapture": true,
          "autoRecall": true,
          "retrieval": { "mode": "hybrid" },
          "governor": {
            "enabledAgents": ["main"],
            "runtimeVectorOnlyRecall": true,
            "injectionLayerBudget": {
              "selfImprovement": 0.2,
              "memory": 0.5,
              "governance": 0.3
            },
            "internalScheduler": {
              "enabled": true,
              "tickIntervalMs": 600000,
              "firstInstallBackfillEnabled": true
            }
          }
        }
      }
    }
  }
}
```

### Configuration Reference

Key recommendations:

- `governor.enabledAgents` — non-empty list for first-install + threshold scope
- `governor.runtimeVectorOnlyRecall = true`
- `governor.injectionLayerBudget = { selfImprovement: 0.2, memory: 0.5, governance: 0.3 }`
- `governor.internalScheduler` — gateway heartbeat: first-install + archive TTL only
- `contextFlush.*` — threshold line, polling, injection `query`
- `rotateOnAgentEnd` — **removed** (ignored by the plugin)

### Commands

```bash
npm run governor:daily-rotate
npm run governor:daily-rotate:all-agents
npm run governor:bootstrap
npm run governor:flush
npm run governor:governance
npm run governor:audit-inspect
npm run governor:audit-restore
npm run governor:audit-clear-rotation
npm run governor:audit-purge-memories
npm run governor:rollback-first-install
npm run governor:archive-prune
npm run governor:verify-layered-injection
npm run governor:test-full-strip
```

### Operations and Troubleshooting

- No recall: check API keys, `autoRecall`, and `dbPath`.
- Excess governance injection: tighten strict retrieval and reduce governance budget.
- Duplicate reminders: avoid enabling multiple reminder providers simultaneously.
- Context bloat: lower recall budget and keep `runtimeVectorOnlyRecall=true`.

### FAQ

**Why split memory stores?**  
To separate runtime recall from governance retention and avoid retrieval contamination.

**Do session files still exist?**  
While chatting, transcripts live under `sessions/*.jsonl`. After a strip, only one **empty** active jsonl remains; originals are copied to `archive/governor-full/<timestamp>/`.

**How to roll back first-install backfill?**  
Run `npm run governor:rollback-first-install` (`rollback-first-install-backfill`). `rotatedDateKeysAsc` is stored in `first-install-bootstrap.json`. The newest pipeline uses **`governor-full` archives** and **`audit.jsonl` as evidence**; if rollback still expects `snapshots/<date>.json` from CLI `nightly`, that file may no longer be generated—combine with archive recovery. Use `--dry-run` first; `--all-governor-agents` matches `governor.enabledAgents`; see `--help` for cleanup flags.

```bash
npm run governor:rollback-first-install -- --agent main --dry-run
npm run governor:rollback-first-install -- --all-governor-agents
npm run governor:rollback-first-install -- --agent main --dates 2025-03-01,2025-03-02
```

### License

MIT
