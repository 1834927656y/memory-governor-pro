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
   当上下文接近上限或任务结束时，触发精炼沉淀进展，后续继续读取，降低上下文压缩导致的“任务断片”。

4. **让行为可审计、可回滚**  
   精炼、归档、轮转全程落台账；会话文件归档保留；可按日期/批次恢复，不是黑盒。

5. **让会话文件更干净**  
   精炼后 `sessions` 目录收敛为单活动 `jsonl`（仅保留未精炼增量），历史进入归档。

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

#### 3) 生命周期治理面

- 每任务结束可触发精炼  
- 日终与初始化回填兜底  
- 阈值触发用于上下文临界保护  
- 所有关键操作写审计台账，可回滚

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

> 以下示例展示常用生产配置（含三层注入预算、任务结束精炼、严格治理检索）。

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
            "rotateOnAgentEnd": true,
            "rotateOnAgentEndCooldownMs": 120000,
            "runtimeVectorOnlyRecall": true,
            "injectionLayerBudget": {
              "selfImprovement": 0.2,
              "memory": 0.5,
              "governance": 0.3
            },
            "internalScheduler": {
              "enabled": true,
              "runAtLocalTime": "00:05",
              "catchUpOnStartup": true,
              "firstInstallBackfillEnabled": true
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
| `governor.enabledAgents` | 启用治理的 agent 列表 | 明确列出 |
| `rotateOnAgentEnd` | 每任务结束触发精炼 | `true` |
| `rotateOnAgentEndCooldownMs` | 任务结束精炼冷却 | 120000 |
| `runtimeVectorOnlyRecall` | 运行时只读向量库，不回读会话文件 | `true` |
| `injectionLayerBudget` | 三层注入预算（SI/Memory/Governance） | 0.2/0.5/0.3 |
| `internalScheduler.enabled` | 内建调度开关 | `true` |
| `firstInstallBackfillEnabled` | 首装回填 | `true` |

#### E. 路径隔离（非常重要）

| 项 | 路径 | 要点 |
|---|---|---|
| 主记忆库 | `plugins.entries.memory-lancedb-pro.config.dbPath` | 在线召回主来源 |
| 治理记忆库 | `config.json -> lancedb.dbPath` | 治理专用，严禁复用主库 |
| 会话归档 | `agents/<agent>/sessions/archive/` | 审计与回滚使用 |

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
A: 会保留，但以归档为主；运行时注入只走向量库。  

**Q3: 能否按 agent 精细化配置？**  
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
- Task-end rotation, threshold-triggered flush, and bootstrap backfill
- Auditable archive + rollback-oriented state records

### Design Principles

1. **Separation of concerns**
   - runtime memory store vs governance memory store
2. **Layered injection**
   - strict budgeted orchestration across memory sources
3. **Audit-first governance**
   - every rotation/merge/archive action is traceable and recoverable
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
            "rotateOnAgentEnd": true,
            "rotateOnAgentEndCooldownMs": 120000,
            "runtimeVectorOnlyRecall": true,
            "injectionLayerBudget": {
              "selfImprovement": 0.2,
              "memory": 0.5,
              "governance": 0.3
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

- `governor.rotateOnAgentEnd = true`
- `governor.rotateOnAgentEndCooldownMs = 120000`
- `governor.runtimeVectorOnlyRecall = true`
- `governor.injectionLayerBudget = { selfImprovement: 0.2, memory: 0.5, governance: 0.3 }`

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
npm run governor:archive-prune
npm run governor:verify-layered-injection
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
Yes, primarily for archive/audit/rollback. Runtime recall should use vector stores.

### License

MIT
