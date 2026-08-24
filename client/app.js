// app.js — BattleCode WeChat client. Holds the singleton WebSocket bridge
// (utils/ws.js) and globalData (server URL, room, self binding).

const DEFAULT_SERVER = 'wss://battlecode.site';

App({
  onLaunch() {
    this.globalData.serverUrl = DEFAULT_SERVER;
    this.globalData.room = null;        // current RoomSnapshot (filled by lobby)
    this.globalData.me = null;          // PlayerSummary of this socket
    this.globalData.code = null;       // 3-digit room code
    this.globalData.hostToken = null;  // only set when acting as host
  },
  globalData: {}
});