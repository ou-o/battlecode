# AGENTS.md

WeChat 小程序 BattleCode 的客户端（运行在小程序端）。摄像头实时帧 → Worker → `WXWebAssembly` AprilTag 解码 → canvas 叠加 + 攻击 UI。**仅支持 25h9 字典**（其它 16h5 / 36h11 已从 wasm 中移除）。客户端通过 WebSocket 与 `battlecode/server` 交互对战。

## 验证

- **唯一离线检查**：`node tools/test_detect.js`
  - 渲染 25h9 合成标签 `ids 0/1/8/12/29`，期望全部 `OK`，最终 `PASS`；单帧 < 5 ms。
  - 不再涉及任何字典运行时切换（wasm ABI 不再导出 `wxat_set_family`）。
  - 接受自定义 wasm 路径：`node tools/test_detect.js path/to/apriltag.wasm`。
  - 这是唯一可执行信号，验证 `wasm/apriltag.wasm` 实际能解码 25h9 —— 改动 wasm、C 封装、build 脚本导出集、worker ABI 后都应执行一次。
- 不存在 `package.json` / 测试框架 / lint / typecheck。不要发明 `npm run ...`。

## 重新编译 wasm（仅在 C 改动时）

`wasm/apriltag.wasm` 已提交（~114 KB）可直接运行。**仅当 `wasm/wxat.c` 或上游 apriltag 引脚变化**时才需要重编：

```bash
# 需 emsdk 激活（emcc 在 PATH 中）
bash tools/build_wasm.sh
node tools/test_detect.js   # 验证重编
```

- `tools/build_wasm.sh` 从 pinned commit `b7c0ebe...` 克隆 `AprilRobotics/apriltag` 到 `.build/apriltag`（已 gitignore）。
- 关键 flags：`-s STANDALONE_WASM --no-entry`（纯 wasm，`WXWebAssembly` 可加载），`USE_PTHREADS=0`（detector `nthreads=1` 内联）。
- 导出集：`_wxat_init _wxat_detect_rgba _wxat_shutdown _wxat_set_decimate _malloc _free`（**不再导出** `_wxat_set_family`）。修改导出集需同步 `build_wasm.sh` 的 `EXPORTED_FUNCTIONS` 与所有 JS 调用方（`workers/detect.js`、`tools/test_detect.js`）。JS 端访问无下划线前缀。

## 打包 / 发布文件

`project.config.json` → `packOptions.ignore` 从主包排除：
- `.build/`（emsdk 构建缓存）
- `tools/`（构建脚本 + node 测试）
- `wasm/wxat.c`（C 源；只发布 `wasm/apriltag.wasm`）

移动这些路径需同步 `packOptions.ignore` 与 README 目录图。

## App ID & 基础库

- `project.config.json` 中 `appid: "wx489f3055805b78e6"`；也可在开发者工具用 `touristappid` 走游客模式。
- `libVersion: 2.19.4`，`project.private.config.json` 覆盖为 `3.17.1`；有效基础库为后者。Worker + `WXWebAssembly` ≥ 2.15.0；`<camera frame-size>`、`onCameraFrame` ≥ 2.7.0。

## 架构要点（文件名不直接体现）

- 页面：`pages/lobby/lobby`（入口，加入房间+选阵营+绑标签）、`pages/host/host`（简易房主）、`pages/index/index`（战斗）、`pages/result/result`（结算）。主页 `pages/index` 复用 AprilTag 帧识别 + worker。
- Worker `workers/detect.js` 通过 `app.json` → `"workers": "workers"` 声明，`wx.createWorker('workers/detect.js')` 实例化。`pages/lobby` 与 `pages/index` 都会临时实例化同一个 worker（勿并发实例）。
- **微信 Worker API 大小写非标准**：`worker.onMessage(fn)` 注册、`worker.postMessage(obj)` 发送（大写 M），*而非* `self.onmessage` / `self.postMessage`。worker 内部由微信运行时提供 `worker` 与 `onMessage` / `postMessage` 全局。
- **帧→worker 通过结构化克隆复制**（微信不支持 transferables）。`index.js` / `lobby.js` 通过 `this._workerBusy` 丢帧施加背压 —— 触碰帧循环时保留该模式。
- **WASM 内存可在帧间增长**。`workers/detect.js` 每次调用都重新派生 `Uint8Array` / `Float32Array` 视图 —— 不要跨调用缓存 typed-array 视图，否则内存增长后会读到陈旧数据或崩溃。
- **WASI stub 必需**：即便 wasm 是 standalone，仍需 `wasi_snapshot_preview1.{clock_time_get, fd_write, fd_read, fd_close, fd_seek}` 全部为 no-op。`workers/detect.js:makeImports()` 与 `tools/test_detect.js` 提供它们，新增 import 时需保持同步。
- 追踪平滑（`index.js:_updateTrackers`）以 `_CONFIRM=3` 连续帧确认标签，`_DROP=5` 帧丢失后移除。这是 UI 逻辑，wasm ABI 本身只返回单帧原始检测。
- **不再有 family 切换路径**：原 `index.js:onFamilyChange` / worker `setFamily` / 持久化 `apriltag_family` 均已删除；lobist.Page 流程在 lobby 页完成（输入房间号 → 选阵营 → 选角色 → 拍标签 → 等待房主开始）。

## WASM ABI（`wasm/wxat.c`）

```c
int  wxat_init(void);                                  // 创建 detector，直接加载 25h9
void wxat_set_decimate(float d);                       // d >= 1.0
int  wxat_detect_rgba(const uint8_t* rgba, int w, int h,
                      float* out, int maxdets);        // 0 ok, <0 err
void wxat_shutdown(void);
```

`out` 为 float32：`out[0] = N`，随后每个检测 11 个 float：
`id, cx, cy, p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y`
（角点逆时针，从 (-1,-1) 起）。

`MAX_DETS = 32` 在 `workers/detect.js` 与 `tools/test_detect.js` 各自硬编码（`OUT_FLOATS = 1 + 32*11`）；同时修改两处 —— wasm 只在 `maxdets` 范围内写。

## 调参

默认值位于 `wasm/wxat.c::wxat_init`：`quad_decimate=2.0`、`quad_sigma=0.0`、`refine_edges=1`、`nthreads=1`。帧率低可提高 `quad_decimate`（3.0~4.0）或将 `<camera frame-size>` 设为 `small`。修改需重编 wasm。

## 服务器依赖

客户端通过 `utils/ws.js` 连接 `battlecode/server`（默认 `ws://localhost:3000/socket`），大厅可临时通过「修改服务器地址」修改并持久化到 `wx.setStorageSync('bc_server')`。事件协议与共享类型在 `server/src/protocol.ts`；客户端只暴露 JSON 信封 `{ t, ...payload }`。

## 调参 /Vue小提示

战斗页 `pages/index` 的 `_drawOverlay` 直接给 canvas 画飘字与红框白边 —— 这些是在 canvas 层渲染，不会出现在 wxml 的 floaters 列表里。`banner`（击杀/胜利等横幅）走 wxml。`dead-overlay` 是死亡复活计时蒙版，`end-overlay` 是游戏结束跳结算。