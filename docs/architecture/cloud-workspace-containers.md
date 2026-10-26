# Cloud Workspace 容器化思路

## 核心设计

一个活跃的 Workspace 对应一个独立 Container：

```text
User
 ├── Workspace A → Container A → Volume A
 └── Workspace B → Container B → Volume B
```

- Container 是临时计算环境。
- Volume 持久保存代码、依赖和项目数据。
- 用户进入 Workspace 时启动 Container。
- 空闲一段时间后删除 Container，但保留 Volume。
- 用户再次进入时，使用原 Volume 创建新 Container。

## Agent 如何访问代码

中央 Agent 服务负责 JWT、Session、LLM 和任务调度，不直接执行用户代码。

```text
Browser
  ↓
Agent Control Plane
  ↓ RuntimeBroker
ContainerProvider
  ↓
Container 内的 Agent Worker
  ↓
/workspace/repo
```

Worker 在 Container 内执行：

- 文件读写
- Git Clone、Commit、Push
- Shell 命令
- 代码搜索
- LSP
- 测试和开发服务器

现有的 `EnvironmentProvider`、`RuntimeBroker` 和 `WorkspaceHandle` 可以继续使用，只需增加 `ContainerProvider`。

## Git 仓库导入

推荐把 Git Clone 设计为“创建 Workspace”，而不是开放任意 shell 命令：

1. 用户连接 GitHub 等代码平台。
2. 选择仓库和分支。
3. 创建 Container 与 Volume。
4. 在 Container 中使用短期 Token Clone。
5. Clone 成功后将 Session 绑定到该 Workspace。

第一版可以只支持公开 HTTPS 仓库，暂不自动运行安装脚本和 submodule。

## 生命周期

```text
CREATING → RUNNING → IDLE → STOPPED/DELETED
```

- Agent 工作时保持运行。
- 空闲 15–30 分钟后删除 Container。
- Volume 根据产品策略长期保留或定期清理。
- 定时任务触发时自动恢复 Container。
- Factory Reset 删除 Container 和 Volume，再创建干净 Workspace。

## 安全要求

- Container 使用非 root 用户。
- 禁止 privileged、Docker Socket 和宿主机目录挂载。
- 限制 CPU、内存、PID、磁盘和运行时间。
- Git Token 不写入 URL、日志或 `.git/config`。
- 默认禁止不安全 Git 协议、submodule 和自动 setup。
- 生产规模扩大后迁移到 Kubernetes；执行不可信代码时考虑 gVisor、Kata Containers 或 Firecracker。

## 实施顺序

1. 单机 Docker，实现 Workspace 与 Container 1:1。
2. 增加 Container 创建、休眠、恢复和删除。
3. 实现公开仓库导入。
4. 接入 GitHub App 和私有仓库。
5. 增加配额、任务队列和 Warm Pool。
6. 规模扩大后迁移到 Kubernetes。

