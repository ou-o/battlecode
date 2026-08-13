// pages/lobby/lobby.js — 入口页：加入房间、选阵营/角色、对准标签拍下绑定。
const ws = require('../../utils/ws.js');

const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };

Page({
  data: {
    serverUrl: '',
    showServerInput: false,
    code: '',
    name: '',
    faction: null,
    role: null,
    joined: false,
    snapshot: null,
    me: null,
    phase: 'lobby',
    err: '',
    // binding overlay state
    bindingTag: false,
    bindingError: '',
    bindingFoundIds: [],
    ROLE_CN,
  },

  onLoad() {
    const app = getApp();
    this.setData({ serverUrl: app.globalData.serverUrl, name: wx.getStorageSync('bc_name') || '' });
    ws.getWs();
    this._unsubs = [
      ws.on('room:joined', (m) => {
        const app2 = getApp();
        app2.globalData.code = m.snapshot.code;
        app2.globalData.me = m.me;
        this.setData({ joined: true, snapshot: m.snapshot, me: m.me, phase: m.snapshot.phase, err: '' });
      }),
      ws.on('state', (m) => {
        const app2 = getApp();
        app2.globalData.room = m.snapshot;
        const me = m.snapshot.players.find((p) => p.socketId === app2.globalData.me?.socketId) || null;
        const prevPhase = this.data.phase;
        const phase2 = m.snapshot.phase;
        this.setData({ snapshot: m.snapshot, me, phase: phase2 });
        if (phase2 === 'playing' && prevPhase !== 'playing') {
          wx.navigateTo({ url: '/pages/index/index' });
        }
        if (phase2 === 'ended' && prevPhase !== 'ended' && !this._goneToResult) {
          this._goneToResult = true;
          wx.redirectTo({ url: '/pages/result/result' });
        }
      }),
      ws.on('room:error', (m) => this.setData({ err: m.message })),
    ];
  },

  onUnload() {
    (this._unsubs || []).forEach((u) => u && u());
    this._killBinding();
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    const upd = { [k]: e.detail.value };
    if (k === 'code') upd.code = e.detail.value.replace(/\D/g, '').slice(0, 3);
    if (k === 'name') wx.setStorageSync('bc_name', e.detail.value);
    this.setData(upd);
  },

  toggleServerInput() { this.setData({ showServerInput: !this.data.showServerInput }); },
  onServerInput(e) {
    ws.setServerUrl(e.detail.value);
    this.setData({ serverUrl: e.detail.value });
  },
  gotoHost() { wx.navigateTo({ url: '/pages/host/host' }); },

  joinRoom() {
    const { code, name } = this.data;
    if (!/^\d{3}$/.test(code)) { this.setData({ err: '房间号必须是三位数字' }); return; }
    if (!name || !name.trim()) { this.setData({ err: '请输入昵称' }); return; }
    this.setData({ err: '' });
    ws.send('room:join', { code, name });
  },

  onFactionTap(e) {
    this.setData({ faction: e.currentTarget.dataset.fac });
    ws.send('faction', { faction: e.currentTarget.dataset.fac });
  },
  onRoleTap(e) {
    this.setData({ role: e.currentTarget.dataset.role });
    ws.send('role', { role: e.currentTarget.dataset.role });
  },

  // ---- tag binding overlay ----------------------------------------------
  startBinding() {
    this.setData({ bindingTag: true, bindingError: '', bindingFoundIds: [] });
    this._workerBusy = false;
    setTimeout(() => this._initBinding(), 50);  // wait <camera> mount
  },
  cancelBinding() {
    this.setData({ bindingTag: false });
    this._killBinding();
  },
  _initBinding() {
    // create camera frame listener + detect worker
    try {
      this._cam = wx.createCameraContext();
      this._worker = wx.createWorker('workers/detect.js');
      this._workerReady = false;
      this._worker.onMessage((res) => {
        this._workerBusy = false;
        if (res.type === 'ready') {
          this._workerReady = true;
          if (this._listener) this._listener.start();
          return;
        }
        if (res.type === 'dets') {
          const ids = (res.detections || []).map((d) => d.id).filter((id) => id <= 23).sort((a, b) => a - b);
          if (ids.length && !ids.every((x) => (this.data.bindingFoundIds || []).includes(x))) {
            // refresh detected id(s) — keep newest unique list
            this.setData({ bindingFoundIds: ids });
          }
        }
        if (res.type === 'error') this.setData({ bindingError: res.message });
      });
    } catch (e) {
      this.setData({ bindingError: 'Worker 或相机创建失败: ' + (e?.message ?? e) });
    }
    // start frame listener
    const query = wx.createSelectorQuery();
    query.select('#bindingCam').fields({ node: true, size: true }).exec((res) => {
      // We use the camera frame-size path, not canvas node — easier API.
    });
    if (!this._listener) {
      this._listener = this._cam.onCameraFrame((frame) => {
        if (!this._workerReady || this._workerBusy) return;
        // frame is an ArrayBuffer-like; convert to data
        this._workerBusy = true;
        this._worker.postMessage({ type: 'frame', width: frame.width, height: frame.height, data: frame.data, frameId: Date.now() });
      });
      this._listener.start();
    }
  },
  confirmBinding() {
    const ids = this.data.bindingFoundIds || [];
    if (!ids.length) { wx.showToast({ title: '未检测到标签', icon: 'none' }); return; }
    ws.send('bindTag', { tagId: ids[0] });
    this.setData({ bindingTag: false });
    this._killBinding();
  },
  manualTagInput(e) {
    const v = e.detail.value.replace(/[^\d]/g, '').slice(0, 2);
    const id = v === '' ? null : parseInt(v, 10);
    this.setData({ bindingFoundIds: id == null ? [] : [id] });
  },
  _killBinding() {
    if (this._listener) { try { this._listener.stop(); } catch (e) {} this._listener = null; }
    if (this._worker) { try { this._worker.postMessage({ type: 'shutdown' }); } catch (e) {} this._worker = null; }
    this._workerReady = false; this._workerBusy = false;
  },
});