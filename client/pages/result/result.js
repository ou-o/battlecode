// pages/result/result.js — 结算页：显示队伍胜负与个人统计。
const ws = require('../../utils/ws.js');

const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };

Page({
  data: {
    snapshot: null,
    winnerText: '',
    stats: [],
    ROLE_CN,
  },

  onLoad() {
    const app = getApp();
    const snap = app.globalData.room;
    this.setData({
      snapshot: snap,
      winnerText: snap?.winner ? (snap.winner === 'red' ? '红方胜利' : '蓝方胜利') : '已结束',
      stats: (snap?.stats || []).slice().sort((a, b) => (b.kills - a.kills) || (b.dealt - a.dealt)),
    });
    this._unsub = ws.on('state', (m) => {
      const s = m.snapshot;
      this.setData({
        snapshot: s,
        winnerText: s.winner ? (s.winner === 'red' ? '红方胜利' : '蓝方胜利') : '已结束',
        stats: (s.stats || []).slice().sort((a, b) => (b.kills - a.kills) || (b.dealt - a.dealt)),
      });
    });
  },

  onUnload() { this._unsub && this._unsub(); },

  backToLobby() {
    wx.reLaunch({ url: '/pages/lobby/lobby' });
  },
});