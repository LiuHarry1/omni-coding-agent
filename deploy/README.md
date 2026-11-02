# `deploy/` — Docker 部署

三个镜像、两种部署模式。admin 模式让浏览器跨域调用 agent；SSO 模式通过 web nginx 同源代理 agent API，避免浏览器 Local Network Access 限制。

桌面版（Electron）发布模板见 **[`desktop/`](desktop/)**（Browser-only seed + `agents.picker`）。

```
                    ${FRONTEND_ORIGIN}
   browser ─┬─ 加载 SPA ──────────▶ web   (nginx 静态站)
            └─ API 调用 ──────────▶ agent (headless API)
                ${AGENT_PUBLIC_URL}
```

| 模式 | Compose 文件 | 网关 | 工作区 |
|------|--------------|------|--------|
| **admin** | `docker-compose.admin.yml` | web 源一个共享密码(Basic Auth);agent 源不鉴权,靠内网保护 | 自由切换 |
| **sso** | `docker-compose.sso.yml` | 外部 auth-service 签发 JWT,agent 逐请求校验 | 按用户锁定 |
| **desktop** | 见 [`desktop/README.md`](desktop/README.md) | Electron 本机 agent | 默认 `~/.ai-agent/workspace`；首次从 `desktop/workspace-seed` 落盘 |

---

## 一、构建镜像(三步)

```bash
# 1. base 镜像(含 agent 代码+依赖,慢,代码变了才重建)
npm run build:worker
docker build -f deploy/Dockerfile.agent-base -t ai-agent-base:latest .

# 2. tenant 镜像(FROM harbor base + managed policy 与用户 seed,秒级)
docker build -f deploy/Dockerfile.agent-tenant --build-arg BASE_TAG=latest -t ai-agent-tenant:latest .
# 默认镜像: harbor.advantest.com/dice-zero/ai-agent-base:${BASE_TAG}

# 3. web 镜像(vite 构建 → nginx 静态站)
docker build -f deploy/Dockerfile.web -t ai-agent-web:latest .
```

> 密钥(`OPENAI_API_KEY` 等)**不要**打进镜像,放在 `deploy/.env`,compose 会注入容器。

### Managed / policy（对齐 Claude Code `getManagedFilePath`）

Tenant 镜像打到 **`/etc/ai-agent/`**（可用 `AI_AGENT_MANAGED_DIR` 覆盖）：

| 镜像源 | 容器路径 |
|--------|----------|
| [`deploy/managed/managed-settings.json`](managed/managed-settings.json) | `/etc/ai-agent/managed-settings.json` |
| [`deploy/managed/AGENTS.md`](managed/AGENTS.md) | `/etc/ai-agent/AGENTS.md` |
| [`deploy/managed/.ai-agent/`](managed/) | `/etc/ai-agent/.ai-agent/{skills,agents,commands,rules}` |

**不要**把整个项目 `.ai-agent/` 打进 `/etc`——平台策略只放 `deploy/managed/`；本地开发仍用仓库根 `.ai-agent/settings.json`；Docker 用户可见模板放 `deploy/workspace-seed/`；桌面安装包模板放 [`deploy/desktop/workspace-seed/`](desktop/)。

| 层 | 说明 |
|----|------|
| settings | `user → project → local → managed`（drop-in 先合成再 apply 一次） |
| skills / agents / commands | 同名时 **managed > project > user > plugin** |
| rules | 拼接 managed → user → project；入口 `AGENTS.md` 或 `CLAUDE.md` |

`CLAUDE_CODE_DISABLE_POLICY_SKILLS=1` 可跳过 managed skills。

| 平台默认目录 | 路径 |
|-------------|------|
| Linux | `/etc/ai-agent` |
| macOS | `/Library/Application Support/AiAgent` |
| Windows | `C:\Program Files\AiAgent` |

Agent base 镜像通过 `deploy/requirements.txt` 安装 **`mcp-server-fetch`** 与 **`matplotlib`**（venv: `/opt/venv`）。SSO seed 里 `mcp_server` 使用 `/opt/venv/bin/python -m mcp_server_fetch`。已有用户目录需手动改 settings 或删目录让 seed 重建。matplotlib 用于 bash 出图后由 Read 工具在聊天里直接展示 PNG。

---

## 二、admin 模式(共享密码)

`deploy/.env`:

```bash
WEB_USERNAME=admin
WEB_PASSWORD=super-secret              # UI 登录密码
WEB_PORT=9999                          # web 源端口
AGENT_PORT=4567                        # agent 源端口
FRONTEND_ORIGIN=http://localhost:9999  # web 源(= agent 的 CORS 白名单)
AGENT_PUBLIC_URL=http://localhost:4567 # 浏览器访问 agent 的地址
OPENAI_API_KEY=sk-...                  # 按需填 provider 密钥
```

```bash
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d
# 打开 http://localhost:9999,输入 WEB_USERNAME / WEB_PASSWORD
```

> **安全**:密码只挡 web 源的页面加载,**agent 源不鉴权**——必须把 `AGENT_PORT` 放在内网/VPN/防火墙后,不要暴露公网。生产环境给两个源都套 HTTPS。

---

## 三、sso 模式(外部 auth-service + 按用户工作区)

前提:你已经单独部署了一个签发 HS256 JWT 的 auth-service。

`deploy/.env`:

```bash
JWT_SECRET=<与 auth-service 签名密钥完全一致>   # 信任锚,必填
FRONTEND_ORIGIN=https://app.example.com         # web 源(= agent CORS 白名单)
AGENT_PUBLIC_URL=https://agent.example.com      # 浏览器访问 agent 的地址
AUTH_BASE=https://auth.example.com              # 浏览器访问 auth-service 的地址
WEB_PORT=8090
AGENT_PORT=4567
OPENAI_API_KEY=sk-...
# 可选:每日 token 配额(需 analytics + MySQL)
QUOTA_ENABLED=false
MYSQL_HOST=host.docker.internal
MYSQL_DATABASE=knowbot
```

```bash
docker compose -f deploy/docker-compose.sso.yml --env-file deploy/.env up -d
# 打开 ${FRONTEND_ORIGIN}
```

还需在**外部 auth-service** 把 `FRONTEND_ORIGIN` 加入 `SSO_ALLOWED_RETURN_ORIGINS` 和 `CORS_ALLOWED_ORIGINS`,否则登录回跳会被拒(400)。

### 通过 KnowBot `/code/` 发布

`deploy/docker-compose.sso.yml` 已经写好 KnowBot 的源地址、镜像标签和 Cloud 配置。其中的 `JWT_SECRET` 必须与 KnowBot auth-service 一致。浏览器始终通过 `https://baix.advantest.com` 访问登录和 Agent API：

```bash
docker compose -f deploy/docker-compose.sso.yml up -d
```

Microsoft Entra 只需注册 auth-service 的 callback
`https://baix.advantest.com/sso/microsoft/callback`；Coding Agent 不需要单独的
Microsoft 应用或 callback。登录成功后 auth-service 会回跳
`https://baix.advantest.com/code/#token=...`，Agent 使用共享 `JWT_SECRET`
验证该 KnowBot JWT。

每个用户被锁定到 `/workspace/users/<email>`,首次登录会从 `deploy/workspace-seed/`(打进 tenant 镜像)复制一份初始内容。

### 可选 Cloud Workspace

基础 SSO stack 默认不启用 Cloud Workspace，也不会挂载 `docker.sock`。先构建 worker 和 workspace 镜像，再显式叠加 Cloud override。这个 override 会把 `BAIZE_RUNTIME_PROFILE` 设为 `cloud`，并挂载宿主 `docker.sock`。KnowBot 生产用的镜像标签、实例名和 `docker.sock` 已经写在 `deploy/docker-compose.sso.yml` 里。

```bash
npm run build:worker
docker build -f deploy/Dockerfile.workspace -t agent-workspace:latest .

docker compose -f deploy/docker-compose.sso.yml \
  -f deploy/docker-compose.sso.cloud.yml \
  --env-file deploy/.env up -d
```

可通过 `WORKSPACE_IMAGE`、`WORKSPACE_MEMORY`、`WORKSPACE_CPUS`、`WORKSPACE_IDLE_MINUTES` 等环境变量覆盖默认值。Agent 启动时会检查 Docker daemon 和 workspace 镜像；缺失时会直接给出构建提示。

这里的安全边界面向可信内部用户：用户代码在独立 workspace 容器内执行，保留公网、RFC1918 内网以及内部 HTTP/SSE MCP 访问，以支持 clone、包安装和内部服务；已知云 metadata 地址会被拒绝。Cloud override 会把宿主 `docker.sock` 挂给控制面，因此只能部署在受控主机，不能向不可信用户开放。

已有的 local/legacy 历史会话不会自动绑定到空白 Cloud Workspace；继续使用基础 SSO 模式，或新建 Cloud 会话。这个行为不会删除原会话或文件。

回滚时使用相同的 compose 文件停止 Cloud stack，再只启动基础 SSO stack；不要加 `-v`，已有 workspace volume 会保留：

```bash
docker compose -f deploy/docker-compose.sso.yml \
  -f deploy/docker-compose.sso.cloud.yml \
  --env-file deploy/.env down
docker compose -f deploy/docker-compose.sso.yml --env-file deploy/.env up -d
```

生产容器显式监听 `0.0.0.0`，浏览器来源仍必须列在 `FRONTEND_ORIGIN` / `ALLOWED_ORIGINS`。本地 `npm run cloud:start` 只监听 `127.0.0.1`。

### 逻辑 HOME（`AUTH_ENABLED`）

SSO 请求里 **逻辑 HOME = 用户 workspace**（`USERS_ROOT/<slug>`），不是容器 `/root`：

| 路径 | 含义 |
|------|------|
| `<userWorkspace>/.ai-agent/projects/<key>/memory` | 主 Agent Auto Memory（按项目） |
| `<userWorkspace>/.ai-agent/agent-memory/<agent>` | 自定义 Agent `memory: user`（按租户用户） |
| `<workspace>/.ai-agent/agent-memory[-local]/<agent>` | 自定义 Agent project / local memory |
| `<userWorkspace>/.ai-agent/projects/<key>/` | transcript、tool results、Session Memory `summary.md` / `state.json` |
| `/etc/ai-agent` | 平台 managed/policy（镜像 bake；**不**跟 ALS） |
| `/app/.ai-agent`（进程挂载） | cron `scheduled_tasks.json` 等进程级数据 |

- Bash / 本地 worker 的 `$HOME`（Windows：`USERPROFILE`）在请求内指向用户 workspace；**不是** OS 级隔离，仍可用绝对路径摸到别人目录。
- Seed 只放用户可见模板；敏感默认（模型 key、强制禁用工具等）进 `/etc/ai-agent`，不要进 seed。
- Super 看别人的 session ≠ 代操对方 HOME；工具仍在**请求者** workspace 下跑。
- `state.json` 让 Session Memory 的游标和 generation 在容器/Electron 进程重启后恢复；它不保存 `inFlight` 等进程瞬时状态。
- Remote SSH 的代码工具在远端 Worker 执行，控制面本机的 Rules、Auto Memory 与 Persistent Agent Memory 不注入。

### 工作区权限 (SSO = dontAsk + pinned working dir)

SSO（`AUTH_ENABLED=true`）下 File 工具与 HTTP `/workspace/*` 使用 Claude Code 的 **dontAsk**：工作区外的路径直接拒绝，没有 Allow UI。工作目录固定为用户 pinned `userWorkspace`，Alice 不能批准 Bob 的文件。

桌面（无 AUTH）`permissions.defaultMode`：`default` 工作区外询问；`dontAsk` 工作区外拒绝；`bypassPermissions` 工作区外也放行（仍尊重 `deny`）。旧值 `acceptEdits` / `plan` 会警告并当作 `default`。SSO AUTH 强制 `dontAsk`。Always allow 会写入用户 `~/.ai-agent/settings.json` 的 `permissions.additionalDirectories`；也可以手工预填，例如 `"C:\\Users\\Harry"`。`permissions.allow` 用 `Read(docs/**)` 这类规则自动允许匹配路径；`permissions.deny` 用 `Read(.env)` / `Edit(.env)` 永久拒绝（**deny 优先于 allow 和 Always allow**）。SSO 忽略 `allow` 和 `additionalDirectories`，但仍执行 `deny`。

说明：这是**应用层**隔离。Bash / PowerShell 仍可用绝对路径读其它目录，直到 shell 单独设门。不要用 File deny 当成租户隔离的全部。

可选：`SANDBOX_EXTRA_READ_ROOTS=/opt/shared-templates`（逗号分隔）额外允许只读根（共享模板等）。

---

## 工作区挂载

两个 compose 都把宿主 `./workspaces` 挂到容器 `/workspace`。把项目放在 `./workspaces/<name>`,调用时传 `"workspace": "/workspace/<name>"`。改挂载路径就编辑 `agent.volumes`:

```yaml
volumes:
  - ./workspaces:/workspace:rw   # ← 换成你的路径
  - ./agent-data:/app/.ai-agent:rw  # cron 等进程数据；会话在用户 .ai-agent/projects/
```

---

## 运维

```bash
# 改了配置/重建镜像后,重新 up 即可(只重建有变化的容器)
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d

docker compose -f deploy/docker-compose.admin.yml logs -f agent   # 看日志
docker compose -f deploy/docker-compose.admin.yml exec agent bash # 进容器
docker compose -f deploy/docker-compose.admin.yml down            # 停止
```

(sso 模式把文件名换成 `docker-compose.sso.yml`。)

## 图表预览（ECharts）

设计参考 [search2chart-mcp](https://github.com/iqingyoung/search2chart-mcp) 的「写 HTML 文件 + HTTP 预览链接」交付方式；Skill 工作流参考 [echarts-chartpage](https://github.com/RiverThrimp/echarts-chartpage)。

Agent 通过 `echarts-chart` skill 将交互图表写入 workspace 的 `charts/` 目录，并在回复里给出 preview 链接：

```
{AGENT_PUBLIC_URL}/workspace/preview?path={encodeURIComponent(absPath)}
```

- `GET /workspace` 返回 `previewBaseUrl`（来自 agent 容器环境变量 `AGENT_PUBLIC_URL`）
- 图表 HTML 为单文件，ECharts 5 CDN；浏览器需能访问 CDN（内网可改 skill 模板中的 CDN URL）
- **admin 模式**：agent 无应用层鉴权，preview 链接可直接在新标签打开
- **sso 模式**：`GET /workspace/preview` 在 auth gate 之前放行（仅 `.html` + workspace 路径校验），markdown 预览链接可在新标签直接打开；agent 容器需设置 `AGENT_PUBLIC_URL`（如 `http://10.150.115.69:4567`）

本地开发可在启动 agent 前设置：

```bash
export AGENT_PUBLIC_URL=http://localhost:4567
```

## 排错

| 现象 | 原因 / 解决 |
|------|-------------|
| `Unable to find image 'ai-agent-*'` | 镜像没构建——先跑上面的"构建镜像"三步。 |
| 浏览器控制台报 CORS 错误 | `FRONTEND_ORIGIN` 没设成浏览器实际打开的源,或与 agent 的 `ALLOWED_ORIGINS` 不一致。改对后重新 `up -d`。 |
| `/chat` 连接失败 | `AGENT_PUBLIC_URL` 访问不到 agent,或 agent 没起来:`docker compose logs agent`。 |
| provider 报 401 / 缺 key | `.env` 里没填对应的 `OPENAI_API_KEY` 等。 |
| 页面空白 | web 镜像构建失败,用 `docker build --no-cache -f deploy/Dockerfile.web -t ai-agent-web:latest .` 重建。 |
| sso 登录回跳被拒(400) | 把 `FRONTEND_ORIGIN` 加进 auth-service 的 `SSO_ALLOWED_RETURN_ORIGINS` 和 `CORS_ALLOWED_ORIGINS`。 |
| sso 登录跳到 localhost | 没设 `AUTH_BASE`,改成真实 auth-service 源。 |
| 日志里中文显示为 `<E4><BD>…` 乱码 | 日志本身是合法 UTF-8,是查看端 locale 不对。SSH/终端里先 `export LANG=C.UTF-8 LESSCHARSET=utf-8` 再看;`docker logs` 输出别经过非 UTF-8 的 pager。容器内已默认 `LANG=C.UTF-8`。 |
