# 设计说明：方案 B（镜像 + 自动导入）

## 目标

让**属于工作区的会话**以纯文本快照形式存进 `<workspace>/.dsh/sessions`，随 git 跨机器同步；同时不改变 DSH 原生会话机制（`$DSH_HOME/sessions` 仍是运行时存储）。

## 为什么不是多根持久化后端（方案 A）

调研结论：

- `ctx.sessionPersistence` 是唯一会话读写入口，替换它需要自定义 Facade、用 `ctx.isolate` 挂多个官方 JSONL 实例、投影 header；
- 该替换的故障域是全局（所有会话），且 DSH 处于 `0.2.x-rc`，插件契约不稳定；
- 方案 B 只消费公开服务 + 读写文件，故障域局限在同步功能，可随时卸载。

因此一期采用 B；A 作为后续可评估的升级项。

## 同步语义

- **工作区快照**是交换格式：纯文本 JSONL，第一行 header，后续每行一个事件。
- **原生副本**是运行时唯一被 DSH 读写的存储。
- **导出**：读原生会话（`open(id,'read')`）→ 序列化 → 原子写快照。
- **导入**：读快照 → 与原生比较 → 重建/追加快照 → `attachSession`。
- 快照中 header 的 `cwd` 保持 `originCwd`（原始项目路径），避免不同机器来回改写导致 diff；导入时再映射为本机工作区路径。

## 触发点

### 导出

| 时机 | 条件 | 行为 |
|---|---|---|
| `session/flush` | 会话属于工作区且事件数变化 | 防抖 2s 写快照 |
| `session/disposed` | 属于工作区 | 等 60ms 后立即写 |
| 启动 / 新工作区 | 原生 root 中 `cwd == workspace.path` 的会话 | 补齐导出 |
| 定时扫描 | 脏会话/live 会话 | 补导出 |
| 手动 | — | 立即导出 |

### 导入

| 时机 | 条件 | 行为 |
|---|---|---|
| 启动 | 工作区注册表就绪 | 扫描所有工作区 |
| `domain/changed`（workspace put） | 新工作区 | 扫描该工作区 |
| 定时轮询 | 快照 mtime 变化 | 导入 |
| 手动 | — | 全量导入 |

## 事件比较与冲突

```text
nativeEvents vs snapshotEvents（规范化：working-directory 的 cwd 忽略）
  公共前缀 n
  - n == 双方长度 → equal（跳过）
  - n == native 长度 → remote-ahead（fast-forward）
  - n == remote 长度 → native-ahead（跳过）
  - 否则 → diverged（冲突）
```

fast-forward：
- 原生 header.cwd 与工作区一致 → 通过写句柄追加缺失事件；
- 不一致（例如旧副本）→ 重建为新会话 id（避免破坏原副本）。

diverged：
- 备份两边到 `.dsh/sessions/.backup/<stamp>/<id>/`；
- `keep-both`（默认）：远端分支重建为新 id；
- `local-wins`：只备份；
- `remote-wins`：同 `keep-both`（不做破坏性覆盖）。

**不自动合并**：seq 连续性、turn/step 结构、工具调用副作用都不允许安全合并。

## 跨机器路径

- 快照 header.cwd = 快照来源机器的工作区路径（originCwd）；
- 导入时 header.cwd 改为本机 `workspace.path`；
- 事件中的 `working-directory/change.data.cwd` 同步改写；
- 历史工具结果文本里的旧路径不重写（当前目录由 system prompt 的 working-directory context 提供）。

## 幂等与恢复

- 导出：事件数与索引相同且文件存在 → 跳过；
- 导入：按目录 mtime 记录在 `state.json` 的 `dirs` 中，未变化不重读；
- 导入中断：原生已有会话、快照更长、cwd 一致 → 追加缺失事件即可恢复；
- 导出中断：写 `.tmp` + rename，原文件不受影响。

## 资源边界

| 资源 | 处理 |
|---|---|
| 代码/文件 | 本就在项目目录；插件不改变 |
| 会话日志 | 插件镜像/导入 |
| 技能 | 原生 `.dsh/skills`；不处理 |
| 指令 | 原生项目根 AGENTS.md；不处理 |
| 记忆 | 不随项目（v1） |
| 附件 | 不镜像（v1） |
| 锁 | 不导出；建议 gitignore |
| 投影缓存/索引 | 不提交 |

## 测试矩阵

- 快照往返、seq 校验、header 投影、working-directory 重写；
- 新导入、fast-forward、native-ahead、分叉 keep-both、重复扫描幂等；
- 导出内容、originCwd、只导出匹配工作区、unchanged 跳过；
- 状态文件原子写、machine-id 稳定；
- 实际安装后：启动导出、添加工作区导入、重启后仍可见。

## 风险

| 风险 | 缓解 |
|---|---|
| DSH 事件/服务契约变化 | 只依赖公开服务；`engines.dsh` 限制；测试覆盖 |
| 双写分叉 | fast-forward + 备份 + 保留两份；文档建议单写者 |
| 敏感内容被提交 | 文档警告；快照只写本地文件，不自动提交 |
| 大会话导出耗时 | 防抖 + 事件数跳过 + 上限 `snapshotMaxBytes` |
| 工作区只读 | 记录警告，不阻塞 DSH |
