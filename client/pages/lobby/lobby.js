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
    // 绑定的 ID 输入框（0-23）
    bindInput: '',
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
      ws.on('room:left', () => {
        const app2 = getApp();
        app2.globalData.code = null;
        app2.globalData.me = null;
        app2.globalData.room = null;
        this.setData({ joined: false, snapshot: null, me: null, faction: null, role: null, phase: 'lobby', err: '' });
      }),
      ws.on('room:closed', (m) => {
        const app2 = getApp();
        app2.globalData.code = null;
        app2.globalData.me = null;
        app2.globalData.room = null;
        this.setData({ joined: false, snapshot: null, me: null, faction: null, role: null, phase: 'lobby', err: m?.reason || '房间已关闭' });
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
          // Only auto-advance to the result page when the player is actually
          // viewing the lobby (e.g. an unbound spectator). If the battle page
          // is on top, let it show its own end overlay (with the 查看结算 button)
          // — otherwise lobby would hijack navigation and the overlay never shows.
          const ps = getCurrentPages();
          const top = ps[ps.length - 1];
          if (top && top.route === 'pages/lobby/lobby') {
            wx.redirectTo({ url: '/pages/result/result' });
          }
        }
      }),
      ws.on('room:error', (m) => this.setData({ err: m.message })),
      ws.on('_error', () => this.setData({ err: '无法连接服务器，请检查服务器地址与网络' })),
    ];
  },

  onUnload() {
    (this._unsubs || []).forEach((u) => u && u());
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

  gotoScan() { wx.navigateTo({ url: '/pages/scan/scan' }); },

  joinRoom() {
    const { code, name } = this.data;
    if (!/^\d{3}$/.test(code)) { this.setData({ err: '房间号必须是三位数字' }); return; }
    if (!name || !name.trim()) { this.setData({ err: '请输入昵称' }); return; }
    this.setData({ err: '' });
    ws.send('room:join', { code, name });
  },

  leaveRoom() {
    wx.showModal({
      title: '退出房间', content: '确定退出当前房间？', success: (r) => {
        if (!r.confirm) return;
        ws.send('room:leave');
      },
    });
  },

  onFactionTap(e) {
    this.setData({ faction: e.currentTarget.dataset.fac });
    ws.send('faction', { faction: e.currentTarget.dataset.fac });
  },
  onRoleTap(e) {
    this.setData({ role: e.currentTarget.dataset.role });
    ws.send('role', { role: e.currentTarget.dataset.role });
  },

  // ---- tag binding: 手动输入 ID (0-23) --------------------------------
  bindInput(e) {
    // 只保留数字，不超过两位，并在 0-23 内截断
    let v = (e.detail.value || '').replace(/\D/g, '').slice(0, 2);
    let id = v === '' ? '' : Math.min(23, parseInt(v, 10)).toString();
    this.setData({ bindInput: id });
  },
  submitBind() {
    const v = (this.data.bindInput || '').trim();
    if (v === '') { this.setData({ err: '请输入要绑定的 ID' }); return; }
    const id = parseInt(v, 10);
    if (id < 0 || id > 23) {
      this.setData({ err: 'ID 必须在 0-23 之间' });
      return;
    }
    this.setData({ err: '' });
    ws.send('bindTag', { tagId: id });
  },
});