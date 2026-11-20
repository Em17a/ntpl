# Nightplay 双人语音（Render）

- WebRTC 传输音频；WebSocket `/ws` 转发 ready/offer/answer/ICE/hangup。
- 两位用户各自点击“开启麦克风”并允许浏览器权限。默认不开麦。
- 支持静音、取消静音、结束语音；离开页面释放本地音轨。
- HTTPS 为浏览器麦克风权限前提；Render 默认提供 HTTPS。
- 默认 STUN 不保证所有 NAT 网络可用。建议部署 coturn 或购买托管 TURN。

当前前端使用公共 STUN 地址，尚未接入 TURN 凭据自动下发。若需要 TURN，需要再将服务商提供的临时凭据接入前端 ICE 配置和服务端安全接口；不要把 TURN shared secret 写进网页源码。

测试步骤：两台设备打开同一房间 → 分别加入 → 分别开启麦克风 → 轮流讲话 → 测试静音/取消静音/挂断 → 离开房间后确认麦克风指示灯关闭。
