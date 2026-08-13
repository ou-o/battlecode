// app.js — BattleCode WeChat client. Holds the singleton WebSocket bridge
// (utils/ws.js) and globalData (server URL, room, self binding).

const DEFAULT_SERVER = 'ws://localhost:3000';

App({
  onLaunch() {
    this.globalData.serverUrl = wx.getStorageSync('bc_server') || DEFAULT_SERVER;
    this.globalData.room = null;        // current RoomSnapshot (filled by lobby)
    this.globalData.me = null;          // PlayerSummary of this socket
    this.globalData.code = null;       // 3-digit room code
    this.globalData.hostToken = null;  // only set when acting as host
  },
  globalData: {}
});