// pages/scan/scan.js — 「直接识别」离线模式：不开房、不建角色、不上报，仅跑
// AprilTag 25h9 识别，把当前画面里的所有标签实时框出来并列出 ID。
// 完全离线：不连 ws，不读房间/角色状态。
const detect = require('../../utils/detectWorker.js');
Page({
  data: {
    running: true,
    wasmReady: false,
    statusText: '正在加载检测引擎…',
    fps: '0.0',
    visibleIds: [],   // 当前稳定确认可见的标签 ID 列表
    tagCount: 0,      // 简写：visibleIds.length
  },

  onLoad() {
    this._workerBusy = false;
    this._frameId = 0;
    this._fpsCount = 0;
    this._fpsLastTs = Date.now();
    this._trackers = {};
    this._CONFIRM = 3;
    this._DROP = 5;
    this._canvas = null;
    this._ctx = null;
    this._canvasW = 0;
    this._canvasH = 0;
    this._frameW = 0;
    this._frameH = 0;

    this._initWorker();
    this._initCamera();
    this._initCanvas();
  },

  onUnload() { this._teardown(); },

  onHide() {
    if (this._listener) this._listener.stop();
    this.data.running = false; // 隐藏时暂停采集
  },

  onShow() {
    this.data.running = true;
    if (this.data.wasmReady && this._listener) this._listener.start();
  },

  _initWorker() {
    // 使用全局唯一的 detect worker 单例，订阅其消息（不再各自 createWorker/terminate）。
    this._unsubWorker = detect.subscribe((res) => {
      this._workerBusy = false;
      if (res.type === 'ready') {
        this.setData({ wasmReady: true, statusText: '' });
        if (this._listener) this._listener.start();
        return;
      }
      if (res.type === 'error') {
        this.setData({ statusText: '引擎错误: ' + res.message });
        return;
      }
      if (res.type !== 'dets') return;
      this._updateTrackers(res.detections || []);
      this._frameW = res.width;
      this._frameH = res.height;
      this._fpsCount++;
      const now = Date.now();
      if (now - this._fpsLastTs >= 500) {
        const fps = (this._fpsCount * 1000) / (now - this._fpsLastTs);
        this._fpsCount = 0;
        this._fpsLastTs = now;
        this.setData({ fps: fps.toFixed(1) });
      }
      // 收集稳定可见的 ID
      const ids = [];
      for (const k of Object.keys(this._trackers)) {
        if (this._trackers[k].visible) ids.push(Number(k));
      }
      const cur = ids.join(',');
      if (cur !== this._lastVisibleKey) {
        this._lastVisibleKey = cur;
        this.setData({ visibleIds: ids, tagCount: ids.length });
      }
      this._drawOverlay();
    });
  },

  _initCamera() {
    const ctx = wx.createCameraContext(this);
    if (!ctx.onCameraFrame) {
      this.setData({ statusText: '不支持 onCameraFrame (需 ≥2.7.0)' });
      return;
    }
    this._listener = ctx.onCameraFrame((frame) => {
      if (!this.data.running || !this.data.wasmReady || this._workerBusy) return;
      this._workerBusy = true;
      this._frameId++;
      detect.post({ type: 'frame', frameId: this._frameId, width: frame.width, height: frame.height, data: frame.data });
    });
    this._listener.start();
  },

  _initCanvas() {
    const q = this.createSelectorQuery();
    q.select('#overlay').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const c = res[0].node;
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
      c.width = res[0].width * dpr;
      c.height = res[0].height * dpr;
      this._canvas = c;
      this._ctx = c.getContext('2d');
      this._ctx.scale(dpr, dpr);
      this._canvasW = res[0].width;
      this._canvasH = res[0].height;
    });
  },

  _updateTrackers(dets) {
    const cur = new Set();
    const byId = {};
    for (const d of dets) { cur.add(d.id); byId[d.id] = d; }
    const CONFIRM = this._CONFIRM, DROP = this._DROP;
    for (const id of Object.keys(this._trackers)) {
      const t = this._trackers[id];
      if (cur.has(Number(id))) {
        t.count++; t.misses = 0; t.lastDet = byId[t.id];
        if (t.count >= CONFIRM && !t.visible) t.visible = true;
      } else {
        t.count = 0; t.misses++;
        if (t.misses >= DROP) t.visible = false;
      }
    }
    for (const id of cur) if (!this._trackers[id]) this._trackers[id] = { id, count: 1, misses: 0, visible: false, lastDet: byId[id] };
  },

  _drawOverlay() {
    const ctx = this._ctx;
    if (!ctx) return;
    const W = this._canvasW, H = this._canvasH;
    ctx.clearRect(0, 0, W, H);
    if (!this._frameW || !this._frameH) return;
    const sx = W / this._frameW, sy = H / this._frameH;

    for (const id of Object.keys(this._trackers)) {
      const t = this._trackers[id];
      const d = t.lastDet;
      if (!d) continue;
      // 离线模式：统一用青色标注，可见实线、未确认虚线
      const stroke = t.visible ? '#00ff88' : '#888';
      const p = d.p;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = t.visible ? 3 : 1.5;
      if (!t.visible) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(p[0][0] * sx, p[0][1] * sy);
      for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0] * sx, p[i][1] * sy);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = stroke;
      ctx.beginPath();
      ctx.arc(d.c[0] * sx, d.c[1] * sy, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = '#ffff88';
      ctx.fillText('id=' + d.id, d.c[0] * sx + 8, d.c[1] * sy - 8);
    }
  },

  toggle() {
    const running = !this.data.running;
    this.setData({ running });
    if (this._listener) { if (running) this._listener.start(); else this._listener.stop(); }
    if (!running) {
      this._trackers = {};
      this._lastVisibleKey = '';
      this.setData({ visibleIds: [], tagCount: 0 });
      const ctx = this._ctx;
      if (ctx) ctx.clearRect(0, 0, this._canvasW, this._canvasH);
    }
  },

  goBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: '/pages/lobby/lobby' }) });
  },

  onCameraError(e) {
    this.setData({ statusText: '摄像头错误: ' + (e.detail && e.detail.errMsg || 'unknown') });
  },

  _teardown() {
    if (this._listener) { try { this._listener.stop(); } catch (e) {} this._listener = null; }
    if (this._unsubWorker) { this._unsubWorker(); this._unsubWorker = null; }
    this._trackers = {};
  },
});