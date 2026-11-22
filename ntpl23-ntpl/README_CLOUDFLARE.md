# Nightplay - Cloudflare 版本

本版本以原 `Nightplay_contact_protection_netlify.zip` 为基础迁移，保留 `public/index.html` 原页面，不重做 UI。

## 架构

- Cloudflare Workers Static Assets：同域名提供 `public/` 页面，并把 `/api/*`、`/ws` 交给 Worker。
- Durable Objects：集中处理 WebSocket 房间、双人聊天、WebRTC 信令、节拍器状态、匹配排队与角色校验。WebSocket 使用 Hibernation API。
- D1：保存房间、成员、消息和匹配队列；匹配队列还会记录开麦偏好。
- WebRTC 媒体仍由浏览器点对点传输；Worker 只转发 offer/answer/ICE 信令。

## 重要说明

1. 这不是已部署的网站。需要在你的 Cloudflare 账号创建 D1，并把数据库 ID 写入 `wrangler.jsonc`，然后由你授权部署。
2. 当前采用一个全局 Durable Object 协调所有 Nightplay WebSocket，以避免 D1 缺少 PostgreSQL 行锁/ advisory lock 后出现重复匹配和抢座位问题。它适合当前双人房间规模的初期版本；用户量增长后应拆分为匹配协调器和按房间分片的 Durable Object。
3. 原始 Netlify 数据库数据不会自动迁入 D1。此版本从新 D1 开始；如需迁移旧房间/聊天记录，需要单独导出导入。
4. 原始 TURN 环境变量名称保持不变：`NIGHTPLAY_TURN_URLS`、`NIGHTPLAY_TURN_SHARED_SECRET`、`NIGHTPLAY_TURN_TTL_SECONDS`。不配置 TURN 时，某些网络下语音可能连不上。
5. 联系方式防泄漏已恢复：聊天文字由浏览器和服务端双重检测；语音仅在支持中文设备端识别的浏览器中开放，识别强制在本机执行，不回退云端识别。没有本地模型或浏览器不支持时会阻止开启麦克风。语音不录音、不保存完整转写，并增加约 1.6 秒上行缓冲；这只能降低泄漏风险，不能保证绝对拦截，详见 `VOICE_SETUP.md`。
6. D1 与 Durable Objects 免费额度有使用上限；免费不等于无限量。高并发、超额请求或 TURN 服务可能产生费用。

## 第一次部署步骤

### 1. 创建 D1

在 Cloudflare Dashboard 打开 **Workers & Pages → D1 SQL Database → Create**，数据库名填写 `nightplay-db`。创建完成后复制 Database ID。

打开本项目 `wrangler.jsonc`，把 `database_id` 的占位文字替换为复制的 ID。

### 2. 安装与登录（电脑终端）

```bash
npm install
npx wrangler login
```

### 3. 建表

```bash
npx wrangler d1 migrations apply nightplay-db --remote
```

出现确认提示时输入 `y`。

### 4. 本地检查

```bash
npm run dev
```

终端会显示本地预览地址。先测试房间创建/加入、双向聊天、匹配、角色权限、节拍器和麦克风。

### 5. 发布

```bash
npm run deploy
```

部署完成后 Wrangler 会显示 `workers.dev` 地址。把该地址发给测试者即可，无需 Netlify。

## 可选 TURN 密钥

在 Cloudflare Dashboard 的 Worker 设置中添加环境变量：

- `NIGHTPLAY_TURN_URLS`：逗号分隔的 TURN URL
- `NIGHTPLAY_TURN_SHARED_SECRET`：TURN 服务共享密钥
- `NIGHTPLAY_TURN_TTL_SECONDS`：可选，默认 3600

不要把共享密钥写进前端或提交到 GitHub。

## 保留原项目

`netlify/`、`db/` 和原 `netlify.toml` 等文件保留在 ZIP 中作为迁移前参考；Cloudflare 部署入口是 `src/index.ts` 和 `wrangler.jsonc`。原 Netlify 代码不会被 Cloudflare Worker 加载。
