// pages/host/host.js — 简易房主页：创建房间并显示 token，提示去 web 控制台管理。
const ws = require('../../utils/ws.js');

Page({
  data: {
    serverUrl: '',
    hostName: '',
    codeHint: '',
    created: false,
    code: '',
    hostToken: '',
    err: '',
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
        wx.setClipboardData({
          data: m.hostToken,
          success: () => wx.showToast({ title: 'hostToken 已复制', icon: 'none' }),
        });
      }),
      ws.on('room:closed', (m) => {
        const app2 = getApp();
        app2.globalData.code = null;
        app2.globalData.hostToken = null;
        app2.globalData.isHost = false;
        this.setData({ created: false, code: '', hostToken: '', err: m?.reason || '房间已关闭' });
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

  createRoom() {
    const { hostName, codeHint } = this.data;
    if (!hostName || !hostName.trim()) { this.setData({ err: '请输入房主昵称' }); return; }
    this.setData({ err: '' });
    ws.send('room:create', { hostName, code: codeHint || undefined });
  },

  copyConsoleUrl() {
    const base = this.data.serverUrl.replace(/^ws/, 'http').replace(/\/socket$/, '');
    const url = `${base}/room/${this.data.code}?token=${this.data.hostToken}`;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '控制台地址已复制', icon: 'none' }),
    });
  },

  copyToken() {
    wx.setClipboardData({
      data: this.data.hostToken,
      success: () => wx.showToast({ title: 'token 已复制', icon: 'none' }),
    });
  },
});