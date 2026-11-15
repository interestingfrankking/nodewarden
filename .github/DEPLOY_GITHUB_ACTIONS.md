# 用 GitHub Actions 部署到 Cloudflare Workers

[`.github/workflows/deploy-workers.yml`](./workflows/deploy-workers.yml) 会完成整套部署：
安装依赖 → 构建 Web Vault（`npm run build`）→ 准备 D1 / R2（或 KV）资源 → 生成账号相关的 Wrangler 配置 →
`wrangler deploy` → 同步 `JWT_SECRET` → 用 `/api/config` 做一次冒烟测试。

整个过程只需要 **2 个必填 Secret**：`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
D1 数据库、R2 存储桶、KV 命名空间在第一次运行时会自动创建，之后的运行会复用同名资源，
所以重复执行不会建出一堆重复资源。

仓库里原有的 `wrangler.toml` / `wrangler.kv.toml` 不会被改动，
workflow 会在仓库根目录临时生成一个 `wrangler.ci.toml`（已加入 `.gitignore`，不会提交）。

---

## 1. 创建 Cloudflare API Token

1. 打开 [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. 点 **Create Token** → **Create Custom Token**
3. 按下表添加权限：

| 类型 | 权限 | 作用 |
| --- | --- | --- |
| Account | **Workers Scripts: Edit** | 部署 Worker |
| Account | **D1: Edit** | 创建 / 查询 D1 数据库 |
| Account | **Workers KV Storage: Edit** | KV 模式下创建命名空间 |
| Account | **R2: Edit** | R2 模式下创建存储桶（不用 R2 可省略） |
| Account | **Account Settings: Read** | Wrangler 读取账号信息 |
| Zone | **Workers Routes: Edit** | 只在配置自定义域名时需要 |
| Zone | **DNS: Edit** | 只在配置自定义域名时需要 |

4. **Account Resources** 选你的账号；**Zone Resources** 在需要自定义域名时选对应域名，否则可以留空。
5. 创建后立刻复制 token（只显示一次）。

> 也可以直接用现成的 **Edit Cloudflare Workers** 模板，再额外补上 `D1: Edit` 和 `R2: Edit`，
> 否则第一次运行会报 `Authentication error [code: 10000]` 或 `code: 7403`。

## 2. 填写 Secret / Variable

打开你 Fork 的仓库：**Settings → Secrets and variables → Actions**。

### Secrets（必填）

| 名称 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 token |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID，见 Dashboard 右侧栏「Account ID」，或本机执行 `npx wrangler whoami` |

### Secrets（强烈建议）

| 名称 | 说明 |
| --- | --- |
| `JWT_SECRET` | 32 位以上随机字符串，例如 `openssl rand -base64 48` 的输出。由 workflow 自动写成 Worker Secret；不填则沿用 Worker 上已有的 secret，全新的 Worker 会提示缺少 `JWT_SECRET` |

### Variables（可选）

| 名称 | 说明 |
| --- | --- |
| `CF_AUTO_DEPLOY` | 设为 `true` 后，推送到 `main` 会自动部署；不设则只能手动触发 |
| `CF_D1_DATABASE_ID` | 固定使用某个已存在的 D1 数据库（UUID），留空则按名字查找/创建 |
| `CF_KV_NAMESPACE_ID` | 固定使用某个已存在的 KV 命名空间（32 位 id） |
| `CF_WORKER_VARS` | 额外的明文变量，JSON 对象，例如 `{"HIDE_WEB_VAULT":"1","WEBAUTHN_RP_ID":"vault.example.com"}` |

> 明文变量也可以直接写在 Cloudflare Dashboard 的 **Settings → Variables and Secrets** 里，
> 部署时使用 `--keep-vars`，不会覆盖 Dashboard 上已有的明文变量。

## 3. 运行

**Actions → Deploy to Cloudflare Workers → Run workflow**，参数含义：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `r2` | 附件存储方式：`r2`（需要绑定支付方式，单文件 100 MB，免费 10 GB）或 `kv`（无需绑卡，单文件 25 MiB，免费 1 GB） |
| `worker_name` | `nodewarden` | Worker 名称，也是 `https://<名称>.<你的子域>.workers.dev` |
| `custom_domain` | 空 | 例如 `vault.example.com`；填了会同时绑定自定义域名，域名必须已经托管在同一个 Cloudflare 账号 |
| `d1_database_name` | `nodewarden-db` | D1 数据库名 |
| `r2_bucket_name` | `nodewarden-attachments` | R2 存储桶名（`r2` 模式） |
| `kv_namespace_title` | `nodewarden-attachments-kv` | KV 命名空间名称（`kv` 模式） |
| `dry_run` | `false` | 只构建 + 校验配置，不创建资源、不部署。**配了 Cloudflare 凭据时会额外做只读体检**（`whoami` / `d1 list` / `r2 bucket info` / `deployments list`），可以据此确认 token 权限是否够 |

首次部署完成后：

- Worker 会自己初始化 D1 表结构（项目本身的设计，不需要另外执行 SQL）。
- Durable Object 的两个 migration（`v1-notifications-hub`、`v2-backup-transfer-runner`）由 `wrangler deploy` 自动应用。
- 如果 `JWT_SECRET` 没有配置，打开网页会看到缺少 `JWT_SECRET` 的提示。
- `workers.dev` 默认域名在部分网络环境不可直连，需要的话在 Worker 设置里加自定义域名。

## 4. 常见问题

**`Authentication error [code: 10000]` / `code: 9109`**
Token 权限不足，或 `CLOUDFLARE_ACCOUNT_ID` 不属于这个 token。检查第 1 节的权限表。

**`Failed to create KV namespace ... code: 10014`**
字面意思是「已存在」。脚本会先按标题查找，正常不会触发；如果手动改过名字，
请用 `CF_KV_NAMESPACE_ID` 变量直接固定 id。

**部署成功但网页提示缺少 `JWT_SECRET`**
Secret 没写进去。确认仓库里有 `JWT_SECRET`（不是 Variable），然后重跑一次；
或到 Worker 的 **Settings → Variables and Secrets** 手动添加。

**真实部署后是不是所有人都会被登出？**
只有当你配置了 `JWT_SECRET`、且它的值与 Worker 上现有的密钥不同时才会。Cloudflare 的 secret
创建后无法再读回，所以**想对已有 Worker 零影响就不要在 GitHub 里配置这个 secret**：
workflow 检测不到它时会保留 Worker 上已有的值，只打印一条 warning。
（新 Worker 必须配一个，否则页面会提示缺少 `JWT_SECRET`。）

**冒烟测试 `GET /api/config` 不是 200**
说明 Worker 起来了但运行时有问题，常见原因：D1 绑定 id 不对、R2 没有开通、`JWT_SECRET` 太短。
冒烟测试只是 `::warning::`，不会让部署失败，具体原因看 **Workers → 你的 Worker → Logs**。

**想清空数据重新开始**
删除 Worker 不会删数据。需要同时删除对应的 D1 数据库、R2 存储桶 / KV 命名空间，
否则重新部署后仍然会读到原来的用户和邀请码。

**回滚到上一个版本**

```bash
npx wrangler rollback --name nodewarden
```

或在 Cloudflare Dashboard 的 Worker → Deployments 里回滚。

## 5. 本地复现 / 调试

workflow 里的配置生成脚本可以直接在本地跑，用来检查生成的 TOML 是否符合预期：

```bash
# 需要 Node.js（见 .node-version）
NW_D1_DATABASE_ID=00000000-0000-0000-0000-000000000000 \
NW_R2_BUCKET_NAME=nodewarden-attachments \
NW_WORKER_NAME=nodewarden \
node .github/scripts/prepare-wrangler-config.mjs

cat wrangler.ci.toml
```

脚本会校验 Worker 名称、D1 UUID、R2 存储桶名、KV id、域名格式和 `CF_WORKER_VARS` 的 JSON 结构，
任何一项不合法都会在调用 Cloudflare API 之前直接失败。

## 6. 安全说明

- 仓库里不保存任何账号 ID、token 或 `JWT_SECRET`；`wrangler.ci.toml` 已被 `.gitignore` 忽略。
- `JWT_SECRET` 通过标准输入传给 `wrangler secret put`，不会出现在命令行参数或日志里。
- workflow 使用最小权限 `permissions: contents: read`，checkout 时 `persist-credentials: false`。
- 部署 job 绑定 `environment: production`，凭据只在该 job 内可见；想加人工审批或限制只能从 main 部署，
  到仓库 **Settings → Environments → production** 配保护规则即可，不用改 workflow。
- 两个 action 按 40 位 commit SHA 固定版本，与仓库里已有的 workflow 保持一致。
- 部署串行执行（`concurrency`），避免两个部署互相覆盖或争抢 Durable Object migration。
