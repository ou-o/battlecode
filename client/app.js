// app.js — BattleCode WeChat client. Holds the singleton WebSocket bridge
// (utils/ws.js) and globalData (server URL, room, self binding).

const DEFAULT_SERVER = 'wss://battlecode.site';

function normalizeUrl(v) {
  if (!v) return DEFAULT_SERVER;
  v = String(v).trim();
  if (v.startsWith('ws://') || v.startsWith('wss://')) return v;
  return 'ws://' + v;
}

App({
  onLaunch() {
    this.globalData.serverUrl = normalizeUrl(wx.getStorageSync('bc_server')) || DEFAULT_SERVER;
    this.globalData.room = null;        // current RoomSnapshot (filled by lobby)
    this.globalData.me = null;          // PlayerSummary of this socket
    this.globalData.code = null;       // 3-digit room code
    this.globalData.hostToken = null;  // only set when acting as host
  },
  globalData: {}
});