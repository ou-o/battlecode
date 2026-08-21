# BattleCode 客户端（微信小程序 / AprilTag 25h9）

类 MOBA 对战游戏的客户端。摄像头逐帧 RGBA → Worker 内 `WXWebAssembly` 解码 25h9 标签 → canvas 叠加 + 攻击 / 复活 UI。**仅支持 25h9 字典**，与 [`battlecode/server`](../server) 通过原生 WebSocket + JSON 信封交互。

## 目录结构

```
client/
├─ app.js / app.json / app.wxss / sitemap.json / project.config.json   # 小程序框架
├─ pages/
│  ├─ lobby/              # 入口：输入三位房间号 + 昵称 → 选阵营/角色 → 拍标签绑定
│  ├─ host/               # 简易房主：建房 / 录掩体 / 开始 / 关闭
│  ├─ index/              # 战斗：摄像头识别 + 攻击按钮 + 血条/飘字/横幅/蒙版
│  └─ result/             # 结算：胜负 + 每位玩家战绩
├─ utils/ws.js            # 封装 wx.connectSocket，{ t, ...payload } 信封
├─ workers/detect.js      # Worker：WXWebAssembly 加载 wasm 并解码帧
├─ wasm/
│  ├─ apriltag.wasm      # 仅含 25h9 的检测引擎（~114 KB）
│  └─ wxat.c             # C 封装（build_wasm.sh 用，不参与打包）
└─ tools/
   ├─ build_wasm.sh      # 用 Emscripten 重编 wasm
   └─ test_detect.js     # Node 端离线自检（合成 25h9 标签 → 检测）
```

## 关键 API 与基础库版本

| 能力 | API | 起始基础库 |
|---|---|---|
| 摄像头逐帧 RGBA | `CameraContext.onCameraFrame` | 2.7.0 |
| Worker 中跑 WASM | `WXWebAssembly.instantiate` | 2.15.0 |
| 摄像头 `frame-size` | `<camera frame-size>` | 2.7.0 |
| 2D canvas 节点 | `<canvas type="2d">` | 2.9.0 |

`project.config.json` 中 `libVersion: 2.19.4`，满足以上要求。

> **连接与口令**：客户端经 `/console?pw=<口令>` 建立连接（口令内嵌于 `utils/ws.js` 的 `CONSOLE_PW`，缺省同服务端 `ismism`），因此小程序无需手动输口令即可建房/建房控，玩家动作同样走这条通道。若服务端以不同的 `BC_CONSOLE_PW` 启动，**必须同步改 `client/utils/ws.js` 里的 `CONSOLE_PW`**。

## 快速开始

### 1. 启动后端

```bash
cd .. /server   # ../battlecode/server
npm install
npm run dev     # 监听 3000
```

### 2. 运行客户端（wasm 已预编译）

1. 用「微信开发者工具」打开本目录。
2. 大厅页输入服务器地址（默认 `ws://localhost:3000` 可改），输入昵称与三位房间号加入；或点「我是房主」建房。
3. 真机预览请用微信扫码（开发者工具 → 预览）。首包无需分包：`apriltag.wasm` 仅 ~114 KB。

### 3. 重新编译 WASM（可选）

需要 Emscripten（emsdk）：

```bash
source <emsdk>/emsdk_env.sh
bash tools/build_wasm.sh
node tools/test_detect.js    # PASS 才算成功
```

构建要点：

- `-s STANDALONE_WASM --no-entry`：纯 wasm 模块，无 JS glue，符合 `WXWebAssembly` 加载方式。
- `-s USE_PTHREADS=0`：检测器内部 `nthreads=1`，`workerpool` 退化为主循环内联。
- 仅导出 `_wxat_init` / `_wxat_detect_rgba` / `_wxat_shutdown` / `_wxat_set_decimate` / `_malloc` / `_free`；JS 访问无下划线前缀。
- WASI 导入（`fd_write` 等）在 `workers/detect.js` 以 no-op stub 提供。

### 4. 离线自检

```bash
node tools/test_detect.js
```

预期：对 25h9 `id 0/1/8/12/29` 各跑一遍，全部 `OK`，单帧 < 5 ms，最终输出 `PASS`。

## 检测引擎 ABI（`wasm/wxat.c`）

```c
int  wxat_init(void);                                  // 创建 detector，加载 25h9
void wxat_set_decimate(float d);                       // 调整 quad_decimate（默认 2.0）
int  wxat_detect_rgba(const uint8_t* rgba, int w, int h,
                      float* out, int maxdets);        // 返回 0=ok / 负数=错
void wxat_shutdown(void);
```

`out`（float32）布局：`out[0] = N`，随后每个检测 11 个 float：
`id, cx, cy, p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y`（角点逆时针，从 (-1,-1) 起）。

## 调参（在 `wasm/wxat.c::wxat_init` 中）

| 字段 | 默认 | 说明 |
|---|---|---|
| `quad_decimate` | 2.0 | 在 1/2 分辨率上做四边形检测，速度优先 |
| `quad_sigma` | 0.0 | 不模糊；噪点多可设 0.8 |
| `refine_edges` | 1 | 边缘精修，准确但稍慢；手机算力不足可关 |
| `qtp.min_cluster_pixels` | （库默认 24） | 过滤小噪块 |

帧率偏低可调大 `quad_decimate`（3.0~4.0）或将 `index.wxml` 的 `<camera frame-size>` 改为 `small`。

## 许可与归属

- AprilTag C 库：BSD-2-Clause，原作者 Regents of the University of Michigan。源码 https://github.com/AprilRobotics/apriltag ；构建脚本固定到 commit `b7c0ebe…`。
- BattleCode 业务代码：按 MIT 风格可自由使用与修改。

## ID 区段

玩家 0–23（最多 12 实际对战），掩体 24–33（最多 10），基地固定 34（红）/ 35（蓝）。25h9 字典支持 id 0–35，正好覆盖。