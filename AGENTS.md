# AGENTS.md

BattleCode — AprilTag 25h9 实物 MOBA。两个独立包，无共享构建：`client/`（微信小程序，无 npm）与 `server/`（Node ≥ 18 + TypeScript + ws + Express）。详细客户端坑见 [`client/AGENTS.md`](client/AGENTS.md)。

## 仓库布局

- `client/` —— 微信小程序。摄像头帧 → Worker → `WXWebAssembly` AprilTag 解码 → canvas 叠加 + 攻击 UI。**无 `package.json`、无测试框架、无 lint/typecheck**——别发明 `npm run ...`。唯一离线检查：`node tools/test_detect.js`（须在 `client/` 下跑）。详见 `client/AGENTS.md`。
- `server/` —— ESM Node 服务。`"type": "module"`，`tsconfig` 用 `NodeNext` 模块解析、`strict` + `noUnusedLocals/Parameters`。**TS 相对导入必须带 `.js` 后缀**（如 `import * as rooms from './rooms.js'`），即使源是 `.ts`。
- 构建产物：`server/dist/`（`tsc` 输出，gitignored）、`client/.build/`（emsdk 缓存，gitignored）。

## 服务器命令（在 `server/` 下）

```bash
npm install
npm run dev        # tsx watch src/index.ts，监听 http://0.0.0.0:3000
npm run typecheck  # tsc --noEmit —— 改动后必跑
npm run build      # tsc → dist/
npm start          # node dist/index.js（生产，需先 build）
```

- 无 lint、无单元测试。验证 = `npm run typecheck`；端到端：先 `npm run dev`（后台）再 `node tools/smoke.mjs`（连 `ws://localhost:3000`，跑建房→加入→攻击→复活→胜负全流程）。
- 端口/主机：`PORT` env 默认 `3000`；`HOST` env 默认 `0.0.0.0`（真机调试要用 LAN IP）。
- 路由：`/socket`（玩家 WS）、`/console`（房主 WS，`?hostToken=` 鉴权）、`/healthz`（`{ok, rooms}`），其余静态服务 `server/web/`（房主控制台页）。
- `server/web/console.js` 是宿主控制台前端，与 `client/` 是独立两套前端，但共享同一个 `protocol.ts` 事件名。

## 协议同步约束

事件名、类型、常量（`DAMAGE_PER_HIT=10`、HP、ID 区段、复活时间…）的唯一来源是 [`server/src/protocol.ts`](server/src/protocol.ts)。改动事件名/数值须同步：

- `client/utils/ws.js` + 各页 JS（`client/pages/*/`）
- `server/web/console.js`（房主控制台）

ID 区段：玩家 0–23（实际 ≤ 12 对战）、掩体 24–33（≤ 10）、基地 34 红 / 35 蓝。25h9 字典恰好覆盖 0–35。

## 客户端 wasm

`client/wasm/apriltag.wasm` 已提交（~114 KB，仅 25h9）。**仅在改 `wasm/wxat.c` 或上游 apriltag 引脚时**才用 `tools/build_wasm.sh`（需 emsdk）重编，随后必跑 `node tools/test_detect.js`。导出集调整须同步 `build_wasm.sh` 的 `EXPORTED_FUNCTIONS` 与 `workers/detect.js`、`tools/test_detect.js`。见 `client/AGENTS.md`。

## 客户端连接

默认 `ws://localhost:3000/socket`；大厅页「修改服务器地址」可改并持久化到 `wx.setStorageSync('bc_server')`。真机需指向服务器 LAN IP，且服务器 `HOST=0.0.0.0` 已默认监听全网卡。