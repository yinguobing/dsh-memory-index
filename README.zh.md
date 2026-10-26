# dsh-memory-index

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**现有 Markdown 记忆树**的全文索引。

它把你已经写好的 `MEMORY.md`、`memory/` 日记、`wiki/` 和 `archive/sessions/` 建进一个本地 SQLite FTS5 库，注册 `memory_search`、`memory_read`、`memory_write`，并可选在启动时注入摘要。不需要 embedding、API key、旁路进程，也不要求迁移文件格式。

> 这是词法检索优先的版本；语义检索会作为后续可选层加入，不替代文件树。

## 为什么用它

- **现有文件仍是唯一事实源**：Markdown 文件可读、可改、可 `git diff`、可删除。
- **中文友好**：SQLite 支持时用 FTS5 `trigram`，否则回退 `unicode61`，并做中文 3-gram 扩展。
- **历史会话可搜**：归档的 session Markdown 可以和日记、长期记忆一起检索。
- **默认安全**：只读、不自动召回、不自动建索引，全部需要显式开启。
- **本地**：一个 SQLite 文件，无网络请求、无遥测。

它不是原子事实库、向量记忆服务或 `AGENTS.md` 审批编辑器；它只解决一件事：**让已经存在的记忆树在 DSH 里可检索。**

## 安装

目前还没有发布到 npm。用本地目录或打包后的 tarball 安装。

本地目录：

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-memory-index"
dsh --profile web
```

本地 tarball：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-memory-index-0.1.0.tgz
dsh --profile web
```

以后发布到 npm 后，命令是：

```sh
dsh plugin --profile web add dsh-memory-index
```

安装后在 profile 的 `cordis.patch.yml` 里把 `workspace` 改到你的记忆树目录。bundle 默认用 Harness 进程目录，避免替用户猜个人路径：

```yaml
- id: memory-index
  config:
    workspace: /home/you/notes
    writeMode: readonly
    autoRecall: off
    buildOnStart: false
```

新会话里运行一次 `/memory-rebuild`，再用 `/memory-status` 检查。

## 工具与命令

| 工具 | 用途 |
|---|---|
| `memory_search` | 检索配置的根目录，返回 `path:line` 和片段；`scope` 可限定来源。 |
| `memory_read` | 读取记忆根目录内的文件。 |
| `memory_write` | 追加到当天日记、追加到核心文件，或在写根目录下创建/替换文件。 |

命令：`/memory-status`、`/memory-rebuild`（加 `fts` 可从零重建全文表）。

## 配置

```yaml
- id: memory-index
  name: dsh-memory-index
  config:
    workspace: /home/you/notes
    indexDb: .memory/index.sqlite
    roots:
      - { path: MEMORY.md, source: core }
      - { path: memory, source: daily }
      - { path: wiki, source: wiki }
      - { path: archive/sessions, source: session }
    writeRoots:
      - MEMORY.md
      - memory
    digest:
      - { path: MEMORY.md, maxChars: 3500 }
      - { path: 'memory/{today}.md', maxChars: 1500 }
      - { path: 'memory/{yesterday}.md', maxChars: 1000 }
    timeZone: Asia/Shanghai
    sourcePriority:
      core: 0
      daily: 1
      wiki: 2
      session: 3
    writeMode: readonly       # readonly | readwrite
    autoRecall: off           # off | startup
    buildOnStart: false
    maxResults: 8
    maxFileBytes: 20971520
    maxWriteBytes: 204800
    maxDigestChars: 8000
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | 必填 | 记忆树根目录；所有读写都以它为边界。 |
| `indexDb` | `.memory/index.sqlite` | SQLite 文件，相对 `workspace`，或 `:memory:`。 |
| `roots` | `MEMORY.md`、`memory/`、`wiki/`、`archive/sessions/` | 要索引的文件或目录；`source` 是结果标签。 |
| `writeRoots` | `MEMORY.md`、`memory/` | 允许模型写入的路径；以 `.md` 结尾视为文件，否则视为目录。 |
| `digest` | 核心文件、今天、昨天 | 可选的启动摘要；`{today}`/`{yesterday}` 按 `timeZone` 展开。 |
| `timeZone` | 系统时区 | 用于日记文件名和摘要占位符。 |
| `sourcePriority` | `core`、`daily`、`wiki`、`session` | 数字越小越靠前；未知来源排最后。 |
| `writeMode` | `readonly` | 改成 `readwrite` 才允许 `memory_write`。 |
| `autoRecall` | `off` | 改成 `startup` 才注入摘要。 |
| `buildOnStart` | `false` | 插件加载后在后台建索引。 |
| `maxResults` | `8` | `memory_search` 默认值和上限（1–20）。 |
| `maxFileBytes` | 20 MiB | 超过则跳过。 |
| `maxWriteBytes` | 200 KiB | 单次 `memory_write` 上限。 |
| `maxDigestChars` | 8000 | 启动摘要字符预算。 |

`roots` 和 `writeRoots` 故意分开：可以索引 `wiki/`、`archive/sessions/`，但只允许写 `memory/`。

## 安全模型

- 所有路径都限制在 `workspace` 内，拒绝 `..` 和绝对路径逃逸。
- 读和写都会拒绝路径上已存在的符号链接，防止 `memory/` 里的链接把读写引到工作区外。
- 读使用 `O_NOFOLLOW`；写使用 `0600` 临时文件 + `fsync` + rename。
- 核心文件（默认 `MEMORY.md`）只允许追加。
- `.env*` 和路径中含 `credentials` 的文件不索引。
- 插件不发起任何网络请求。

## 检索行为

- SQLite 支持 `tokenize='trigram'` 时用 FTS5 子串匹配；否则回退 `unicode61`。
- 查询优先用 `Intl.Segmenter` 分词；首轮太窄时用中文 3-gram 扩展。
- 结果按 FTS5 `bm25` 排序，再按来源优先级；短词和分词缺口用 `LIKE` 兜底。
- 行号是 chunk 起始行，长 chunk 里是近似值。

## 限制

- **词法检索，不是语义检索**：找词，不找意思；embedding 检索计划作为可选层。
- **没有文件监听**：外部修改要等下一次 `/memory-rebuild` 或开启 `buildOnStart` 后重启；`memory_write` 会立即索引自己的写入。
- **单写者假设**：SQLite 有 busy timeout，但多进程并发写没有额外协调。
- **默认不跨 profile 共享**：索引库在 `workspace/.memory/`；共享 `indexDb` 前请理解锁模型。
- **`node:sqlite` 在 Node 22/24 可能打印 ExperimentalWarning**；要求 `^22.19.0 || >=24.0.0`。
- **目前只在 Linux 测试**；Windows/macOS 路径逻辑已实现，但还没有 CI。
- **引用是近似行号**；需要精确上下文时用 `memory_read`。

## 路线图

- **可选语义层**：在同一个 `memory_search` 背后加入 embedding 与混合排序；词法 FTS5 仍作为离线兜底。
- **增量监听**：用 debounce 的文件监听替代纯手动重建，同时保留手动命令。
- **Windows/macOS CI**：路径和符号链接检查已按跨平台写；目前测试目标是 Linux。

## 设计来源

核心 `MEMORY.md`、日记、梦境、wiki、历史会话树的记忆模型来自 [OpenClaw](https://github.com/openclaw/openclaw)（MIT）。本包是这套模型在 DSH 上的独立实现，不共享 OpenClaw 代码；目标是保留现有记忆树的形状，而不是复刻 OpenClaw 运行时。

## 开发

```sh
npm install --ignore-scripts
npm test
npm run pack:check
```

测试使用 `node:test` 和临时工作区，覆盖中英文检索、scope、写模式、路径穿越、符号链接逃逸、摘要和 FTS 重建。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
