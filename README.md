# Nightplay（Cloudflare 迁移版）

本项目基于原 Nightplay 源码迁移到 Cloudflare Workers + Durable Objects + D1，保留原中文前端页面和双人互动功能。

**部署前先阅读 [`README_CLOUDFLARE.md`](./README_CLOUDFLARE.md)。** 需要先在自己的 Cloudflare 账号创建 D1 数据库并把 Database ID 填入 `wrangler.jsonc`，然后运行数据库迁移和部署命令。

## 功能

- 双人私人房间、邀请链接、昵称加入
- 实时文字聊天与在线状态
- WebRTC 双向语音信令（音频仍为浏览器点对点传输）
- 性别、控制角色与开麦意愿偏好匹配
- 控制方（S）/受控方（M）角色聊天快捷语
- 支持固定节奏、随机变速、难度和时长的双人节拍挑战
- 无需匹配对象的本地单人节奏练习

## 重要

- 此 ZIP 是待部署源码，不代表网站已经部署。
- Netlify 数据不会自动迁移到新 D1 数据库。
- 不配置 TURN 时，部分网络环境可能无法建立语音连接。
- 麦克风默认关闭，只有用户主动点击后才请求权限；应用不录制或保存语音。
- Cloudflare 免费额度有上限，并非无限量。
