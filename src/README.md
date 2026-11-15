# Agent (`src/`)

Coding agent 核心实现：`tools/*Tool/` 包、根级 `tools.ts` 注册表、以及 `core/` / `services/` / `commands/` / `skills/`。

由仓库根目录 [`start.js`](../start.js) 加载（`npm start` / `--stdio` / `--acp`）。

## 目录

```text
src/
├── tools.ts              # 工具注册表（导入各 *Tool 并写入 defaultRegistry）
├── entrypoints/          # 启动入口：cli.ts 按参数分发到 server/ · cli/ · acp/ · worker/
├── tools/                # PascalCase *Tool 包（BashTool、FileReadTool、AgentTool…）
├── turn/                 # 一轮对话的宿主：run-chat-turn.ts、prepare-chat-turn.ts
├── core/                 # agent 循环（agent.ts → query.ts）、LLM、registry、plugins、permission mode
├── services/             # compact、lsp、auto-memory、session-memory…
├── commands/             # slash commands
├── skills/               # Skill 加载与 fork
├── server/               # HTTP / SSE / stdio / workspace API
├── acp/ · cli/           # ACP 与 stdio CLI
├── prompts/ · utils/ · constants/
├── tests/                # 旧式测试脚本 test-*.ts,经 tests/suites/*.test.ts 由 vitest 运行;tests/suites/live/ 需要 Chrome / 运行中服务
└── dev/                  # 开发者工具(browser-pair、browser-dev-chrome)
```

## 工具约定

每个工具一个文件夹：

```text
tools/FooTool/
  FooTool.ts    # export const definition: ToolDefinition
  prompt.ts     # 名称常量 / 描述（无 Ink UI.tsx — 渲染在 Web 客户端）
```

在 [`tools.ts`](tools.ts) 中 import 并 `defaultRegistry.register(...)`。运行时工具名仍来自 [`constants/tool_names.ts`](constants/tool_names.ts)（`Bash`、`Read`、`Agent`…）。

共享非工具辅助：`tools/shell-runner.ts`、`tools/http-utils.ts`、`tools/utils.ts`。

## 子代理（Agent tool）

单一 `Agent` 工具（`tools/AgentTool/`），通过 `subagent_type` 分发：

| agentType | 模式 | 用途 |
|-----------|------|------|
| `Explore` | 只读 | 并行搜索、读文件、结构化汇报 |
| `Plan` | 只读 | 架构规划 |
| `general-purpose` | 读写 + shell + web | 开放式多步任务 |

内置定义在 `tools/AgentTool/built-in/`；磁盘 / 插件 agents 经 `loadAgents.ts` + `mergeAgents.ts` 合并后注册。

## 配置与扩展

- 用户级：`~/.ai-agent/settings.json`
- 项目级：`<workspace>/.ai-agent/settings.json`（以及 `agents/`、`commands/`、`skills/`、`plugins/`）
- 目录名可由 `AI_AGENT_DIR` 覆盖（见 `utils/app-dir.ts`）

### 添加新工具

1. 新建 `tools/MyTool/MyTool.ts` + `prompt.ts`，导出 `definition`
2. 在 `tools.ts` 注册
3. 如需从模型侧隐藏，用 `shouldDefer` / `disabledTools` / mode 限制

### 添加 LLM Provider

1. 在 `core/llm/strategies/` 实现策略
2. 在 `core/llm/index.ts` 注册
3. 扩展 `ProviderId` 类型

### 项目规则

在项目根创建 `AGENTS.md`（从 git root 到 cwd 向上合并）。

## 更多

历史演进与能力说明见 [`docs/`](../docs/README.md)。集成测试：`npx tsx src/tests/test-*.ts`。
