# 轨道花园 · Orbit Bloom

竖屏一指小游戏：注册账号后，可玩**单人闯关（100 关）**，或与真人**联网 1v1 对决**。

## 玩法

- 拖动「守护卫星」在轨道上移动，接住青色 **星种**，避开粉色 **碎晶**。
- 长按屏幕蓄力，松开释放**共振脉冲**，净化范围内的碎晶。
- **单人闯关**：收集够本关目标星种即过关，逐关解锁，难度递增（共 100 关）。
- **好友 PK（开房间）**：创建房间获得 6 位房号，发给好友，好友输入房号加入后，双方在相同星种序列下 50 秒同屏比拼分数，先手分高者胜。
- **充值**：顶部「充值」入口，展示微信收款码（`public/recharge.jpg`）与「扫码 1 元获得秘籍」提示（展示页，实际到账需自行接入微信支付）。

## 运行

需要 Node.js 18+（本机已装 v22）。

```bash
npm install   # 安装唯一依赖 ws
npm start     # 启动服务，默认 http://localhost:3311
```

浏览器打开 `http://localhost:3311` 即可。

## 联机对战

- **本机测试**：开两个浏览器窗口（或一个正常窗口 + 一个隐身窗口），分别注册两个账号，一个点「创建房间」拿到房号，另一个输入房号「加入」。
- **同一 WiFi（局域网）**：其它设备访问 `http://<服务器IP>:3311`（启动时会打印本机 IP；`ipconfig` 可查 IPv4 地址）。
- **不同 WiFi（公网）**：需要把服务部署到云端，见下一节。

## 部署到 Render（不同 WiFi 也能对战）

> Netlify Drop 只能托管静态文件，跑不了这个 WebSocket 后端，所以真人 1v1 要部署到支持 Node + WebSocket 的平台。这里用 Render 免费版。

1. 把项目推到一个 GitHub 仓库（`package.json`、`server.js`、`public/`、`render.yaml` 都在根目录）。
2. 打开 [render.com](https://render.com) 注册/登录 → 点 **New + → Blueprint**（或 **New → Web Service**），连接该仓库。
3. Blueprint 会读取 `render.yaml` 自动配置：构建 `npm install`、启动 `npm start`、健康检查 `/health`。
4. 部署完成后得到公网地址，例如 `https://orbit-bloom.onrender.com`，把这个链接发给任何人，**不同 WiFi 也能对战**。

### Render 免费版注意事项

- 服务**闲置约 15 分钟会休眠**，下次访问要冷启动几秒。
- 文件系统是**临时的**：`data/players.json` 里的账号与战绩会在重新部署/重启后**丢失**（在线会话本来就存内存）。想要永久保存需接数据库（Render 免费 Postgres / Supabase）。


## 目录结构

```
ban-2/
├── server.js          # Node 后端：静态服务 + WebSocket（注册/登录/匹配/房间/比分同步）
├── public/index.html  # 前端单文件（全部样式与逻辑）
├── data/players.json  # 运行时生成：账号 + 战绩（密码加盐哈希存储）
└── package.json
```

## 说明与限制

- 账号密码用 `crypto.scrypt` 加盐哈希落盘，不明文存储。
- 1v1 采用「客户端上报比分、服务端转发 + 权威计时」的信任模型，适合休闲对战；若需防作弊需服务端权威模拟。
- 会话 token 存于内存，服务重启后需重新登录；账号与战绩持久保留。
