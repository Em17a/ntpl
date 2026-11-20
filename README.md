# Nightplay — Render 部署版

这是 Render 原生 Node Web Service + PostgreSQL 版本。服务端同时提供网页、HTTP API 和 WebSocket，不需要 Netlify Functions。

## GitHub 上传
1. 解压本 ZIP。
2. 将解压后的**全部内容**上传到 GitHub 仓库根目录（不要把 ZIP 本身当作源码上传）。
3. 确认仓库根目录能直接看到 `render.yaml`、`package.json`、`server.ts`、`src/`、`db/`、`public/`。

## Render 部署
1. Render Dashboard → New → Blueprint。
2. 连接 GitHub 并选择该仓库。
3. Render 读取根目录 `render.yaml`，创建 `nightplay` Web Service 和 `nightplay-db` PostgreSQL。
4. 确认资源区域均为 Singapore 后 Apply。
5. 部署完成后访问 Render 提供的 `https://...onrender.com`，健康检查为 `/api/health`。

`render.yaml` 会自动注入 `DATABASE_URL`，并设置 `DATABASE_SSL=true`。服务监听 Render 提供的 `PORT`，绑定 `0.0.0.0`。

## 本地运行
需要 Node.js 22 和 PostgreSQL。设置 `DATABASE_URL` 后执行：

```sh
npm install
npm start
```

## 功能
- 最多两人进入同一房间；通过邀请链接和昵称加入
- WebSocket 实时文字聊天、成员在线状态和房间消息记录
- 双向 WebRTC 语音；麦克风默认关闭，可静音和挂断
- PostgreSQL 保存房间、成员和消息

## 测试说明
部署后必须使用两台设备、两个不同网络环境实测。当前内置 STUN；某些运营商/NAT 环境可能需要额外配置 TURN，不能仅凭部署成功就保证所有网络均能通话。
