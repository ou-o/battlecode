// pages/host/host.js — 简易房主页（创建房间/录掩体/开始）。
const ws = require('../../utils/ws.js');

Page({
  data: {
    serverUrl: '',
    hostName: '',
    codeHint: '',
    created: false,
    code: '',
    hostToken: '',
    snapshot: null,
    phaseText: '',
    err: '',
    bunkerInput: '',
  },

  onLoad() {
    const app = getApp();
    this.setData({ serverUrl: app.globalData.serverUrl, hostName: wx.getStorageSync('bc_name') || '房主' });
    ws.getWs();
    this._unsubs = [
      ws.on('room:created', (m) => {
        const app2 = getApp();
        app2.globalData.code = m.code;
        app2.globalData.hostToken = m.hostToken;
        app2.globalData.isHost = true;
        this.setData({ created: true, code: m.code, hostToken: m.hostToken, err: '' });
        wx.setClipboardData({ data: m.hostToken, success: () => wx.showToast({ title: 'token 已复制', icon: 'none' }) });
      }),
      ws.on('state', (m) => {
        const snap = m.snapshot;
        const txt = ({ lobby: '大厅', binding: '绑定中', armed: '就绪', playing: '对战中', ended: '已结束' })[snap.phase] || snap.phase;
        this.setData({ snapshot: snap, phaseText: txt });
        if (snap.phase === 'playing' && !this._jumped) {
          this._jumped = true;
          wx.navigateTo({ url: '/pages/index/index' });
        }
        if (snap.phase === 'ended' && !this._ended) {
          this._ended = true;
          wx.redirectTo({ url: '/pages/result/result' });
        }
      }),
      ws.on('room:error', (m) => this.setData({ err: m.message })),
    ];
  },

  onUnload() { (this._unsubs || []).forEach((u) => u && u()); },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    let v = e.detail.value;
    if (k === 'codeHint') v = v.replace(/\D/g, '').slice(0, 3);
    this.setData({ [k]: v });
  },
  onBunkerInput(e) { this.setData({ bunkerInput: e.detail.value }); },

  createRoom() {
    const { hostName, codeHint } = this.data;
    if (!hostName || !hostName.trim()) { this.setData({ err: '请输入房主昵称' }); return; }
    this.setData({ err: '' });
    ws.send('room:create', { hostName, code: codeHint || undefined });
  },

  bindBunkers() {
    const ids = (this.data.bunkerInput || '')
      .split(/[,\s，]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => !isNaN(n) && n >= 24 && n <= 33);
    if (!ids.length) { this.setData({ err: '请填入 24–33 范围内的掩体 ID' }); return; }
    this.setData({ err: '' });
    ws.send('host:bunkers', { ids });
  },

  startGame() {
    if (this.data.snapshot?.phase === 'playing') return;
    this.setData({ err: '' });
    ws.send('host:start');
  },

  closeRoom() {
    wx.showModal({
      title: '关闭房间', content: '房间将无法重连，玩家会被踢出。继续？',
      success: (r) => { if (r.confirm) ws.send('host:close'); },
    });
  },
});