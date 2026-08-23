# BattleCode

基于 AprilTag 25h9 的类 MOBA 实物对战游戏：小程序客户端识别物理标签 → 上报给 WebSocket 服务端 → 服务端结算血量、复活、胜负。

## 仓库结构

```
battlecode/
├─ client/         # 微信小程序（AprilTag 25h9 实时识别 + 对战 UI）
│  ├─ pages/         lobby · host · index(战斗) · result(结算)
│  ├─ utils/ws.js    原生 wx.connectSocket 封装，{t, ...payload} 信封
│  ├─ workers/detect.js WXWebAssembly AprilTag 解码 worker
│  ├─ wasm/apriltag.wasm 25h9-only 检测引擎（已编译，~114 KB）
│  └─ tools/         build_wasm.sh / test_detect.js
└─ server/         # Node.js + TypeScript + ws + Express
   ├─ src/
   │  ├─ protocol.ts   共享事件名/类型/常量（DAMAGE_PER_HIT=10 等）
   │  ├─ rooms.ts       房间生命周期、ID 绑定、状态机
   │  ├─ game.ts       攻击结算、死亡复活、掩体销毁、基地胜负、统计
   │  └─ index.ts      HTTP + WebSocket 路由（/socket 玩家、/console 房主控制台）
   ├─ web/             控制台静态页（/console 路由）
   └─ tools/smoke.mjs  端到端冒烟测试脚本
```

## 快速开始

### 1. 启动服务器

```bash
cd server
npm install
npm run dev        # tsx watch src/index.ts，监听 http://localhost:3000
```

环境要求：Node ≥ 18。

### 2. 启动小程序客户端

```bash
# 用微信开发者工具打开 client/ 目录即可（wasm 已预编译）。
```

### 3. 房主控制台

浏览器打开 `http://localhost:3000/` → 房主昵称 + 自选三位房间号（可留空随机）→ 「建房」→ token 与房间号自动显示。

### 4. 玩家流程

1. 小程序「加入对局」页输入昵称 + 三位房间号加入。
2. 选阵营（红 / 蓝）+ 角色（突击兵 / 工程师 / 狙击手，仅枚举，特性留待后续）。
3. 「拍标签绑定」→ 用摄像头识别自己的 25h9 标签 → 绑定到 ID（0–22）。
4. 房主在控制台录入掩体（23–32 中若干）→ 点「开始游戏」。
5. 玩家被自动跳进战斗页：摄像头识别 + 「攻击」按钮上报当前识别到的所有 IDs → 服务端对每个被击单位扣 10 点。
6. 玩家 hp=0 → 阵亡，30s 倒计时结束后到本方基地前拍下基地标签（id 33 红 / 34 蓝）复位复活。
7. 掩体 hp=0 → 一次性销毁，本局不再重生。
8. 某方基地 hp=0 → 游戏结束，跳转结算页显示个人战绩。

## 默认数值（`server/src/protocol.ts`）

| 项 | 默认 |
|---|---|
| 单次攻击伤害 | 10 |
| 玩家 HP | 100（10 次被击致死） |
| 掩体 HP | 2000（被击 200 次摧毁） |
| 基地 HP | 500（50 次被击陷落） |
| 复活等待 | 30s |
| 玩家 ID 区段 | 0–22 |
| 掩体 ID 区段 | 23–32 |
| 基地 ID | 33 红 / 34 蓝 |
| 最大玩家数 | 12 |
| 最大掩体数 | 10 |

## 通信协议

原生 WebSocket，JSON 信封 `{ t: <eventName>, ...payload }`。事件名与类型在 [`server/src/protocol.ts`](server/src/protocol.ts) 定义，与小程序端 `client/utils/ws.js`、各页 JS 以及控制台 `server/web/console.js` 对齐。

C2S：`room:create / room:join / faction / role / bindTag / host:bunkers / host:start / host:close / attack / respawn`。

S→C：`room:created / room:joined / state (RoomSnapshot 全量快照) / event (增量 GameEvent) / room:error`。

## 自检

```bash
# 客户端 wasm 解码自检
cd client && node tools/test_detect.js        # 25h9 → PASS

# 服务端 TS typecheck
cd ../server && npm run typecheck

# 服务端端到端冒烟
npm run dev &     # 后端起来
node tools/smoke.mjs
```

## 重编 wasm（仅 C 改动时需要）

```bash
source <emsdk>/emsdk_env.sh
cd client
bash tools/build_wasm.sh
node tools/test_detect.js
```

## 路线图（留待后续）

- 角色特性（突击兵 / 工程师 / 狙击手差异化技能）
- 工程师治疗他人 → 计入累计治疗量
- 实时地图位置上报与观战地理可视化