# CONTRACT

本文件描述 dsh-workspace-session 对宿主、对浏览器、对文件系统的稳定契约。

## Host

### 插件

- 包名：`@local/dsh-workspace-session`
- Cordis 插件名：`dsh-workspace-session`
- 注入：`sessionPersistence`（工作区注册表按需读取，缺失时插件作为空操作运行）

### 依赖的 Harness 服务/事件

| 名称 | 用途 |
|---|---|
| `ctx.sessionPersistence.list/stat/open/create` + `SessionHandle` | 读写会话 |
| `ctx.workspaceRegistry.list()` | 枚举工作区 |
| `Workspace.attachSession(id)` | 导入后归组 |
| `ctx.get('sessions').list()` | 定时兜底导出的 live 会话 |
| `session/flush` | 导出触发（防抖） |
| `session/disposed` | 最终导出 |
| `domain/changed` | 新工作区触发导入/导出 |
| `connection.fetch.register` | 可选 HTTP 路由（Web profile） |

### 文件契约

| 路径 | 读写 | 内容 |
|---|---|---|
| `<workspace>/.dsh/sessions/<encoded-id>/session.v4.jsonl` | 插件读写 | 文本快照：第一行 header + 每行事件，`seq` 从 0 连续 |
| `<workspace>/.dsh/workspace-session.json` | 插件读写 | 机器本地快照索引（originCwd/事件数/指纹）；**可 gitignore**，缺失时 exporter 从快照第一行 header 恢复 originCwd |
| `<workspace>/.dsh/sessions/.backup/<stamp>/<id>/` | 插件写 | 冲突备份（remote.jsonl / native.jsonl） |
| `$DSH_HOME/dsh-workspace-session/config.json` | 插件写 | 配置 |
| `$DSH_HOME/dsh-workspace-session/state.json` | 插件写 | 本机状态（工作区/会话/冲突） |
| `$DSH_HOME/dsh-workspace-session/machine-id` | 插件写 | 稳定机器标识 |

### 快照格式

```jsonl
{"type":"session","version":4,"id":"session-...","createdAt":1700000000000,"cwd":"/original/project","isSeeded":false,"delegationDepth":0}
{"type":"turn/start","seq":0,"time":...,"data":{"turn":1}}
```

- `version` 必须是 4；其他版本跳过并记录。
- `cwd` 是原始项目路径（`originCwd`），导入时改写为本机工作区路径。
- 事件按 `seq` 0..n-1 连续；`working-directory/change.data.cwd` 在导入时改写。
- fork/seeded 会话通过事件流中的 `session/end-seed`（`data.inherited === true`）推断 `inheritedEventCount`；导出时同时记录在 `workspace-session.json`。

## HTTP API（仅 Web profile）

前缀：`/api/dsh-workspace-session`；只对 owner peer 开放。

### `GET /state`

```json
{
  "ok": true,
  "value": {
    "enabled": true,
    "machineId": "...",
    "config": { "...": "..." },
    "workspaces": [{ "path": "...", "title": "...", "root": "...", "snapshots": 0, "importedSessions": 0, "lastScanAt": "...", "sessionIds": 0 }],
    "conflicts": [],
    "lastSweepAt": "...",
    "pendingExports": 0
  }
}
```

### `POST /action`

| action | body | 行为 |
|---|---|---|
| `sync` | `{ force? }` | 导入 + 导出所有工作区 |
| `import` | `{ force? }` | 只导入 |
| `export` | `{ force? }` | 只导出 |
| `config` | `{ patch: {...} }` | 校验并保存配置，重装轮询 |
| `status` | `{}` | 返回状态 |

响应：`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。

## Client

- 入口：`client.js`，通过 `window.__ModuleLoader__.load({ id: '@local/dsh-workspace-session', factory })` 注册。
- 依赖：`slots`、`locale`。
- 注册：`settings.section`（id `workspace-session`，order 40，label 来自 `locale/zh.json`/`en.json` 的 `meta.title`）。
- 不 require 任何 Harness 客户端包，只 require React。

## 状态与错误

- 配置非法时回退默认值并警告。
- 单会话导出/导入失败记录警告，不影响其他会话。
- 冲突不删除任何一方；备份保留在 `.backup`。
- 工作区只读/磁盘满时跳过并记录，不阻塞 DSH。
