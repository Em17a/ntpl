# Nightplay（Cloudflare 迁移版）

本项目基于原 Nightplay 源码迁移到 Cloudflare Workers + Durable Objects + D1，保留原中文前端页面和双人互动功能。

**部署前先阅读 [`README_CLOUDFLARE.md`](./README_CLOUDFLARE.md)。** 需要先在自己的 Cloudflare 账号创建 D1 数据库并把 Database ID 填入 `wrangler.jsonc`，然后运行数据库迁移和部署命令。

## 功能

- 双人私人房间、邀请链接、昵称加入
- 实时文字聊天与在线状态
- WebRTC 双向语音信令（音频仍为浏览器点对点传输）
- 性别偏好与控制方/受控方角色偏好匹配
- 节拍器寸止挑战、控制方权限与受控方紧急停止
- 联系方式文字过滤、浏览器本地语音识别保护

## 重要

- 此 ZIP 是待部署源码，不代表网站已经部署。
- Netlify 数据不会自动迁移到新 D1 数据库。
- 不配置 TURN 时，部分网络环境可能无法建立语音连接。
- 浏览器本地语音识别属于尽力而为的保护，不保证零泄漏。
- Cloudflare 免费额度有上限，并非无限量。
