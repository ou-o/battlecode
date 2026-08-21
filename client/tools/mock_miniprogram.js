// mock_miniprogram.js — 极简微信小程序运行时桩。
// 用途:在纯 Node 里加载 client 的 app.js / utils/ws.js(不加载依赖相机/worker
// 的页面),用真实 WebSocket 连接服务端,从而无需微信开发者工具也能实测连接 /
// 口令 / 断线重连逻辑。用法见 run_mock_test.js。
//
// 依赖:ws 取自 client 相对的 server/node_modules。
const path = require('path');
const RealWS = require(path.resolve(__dirname, '../../server/node_modules/ws'));

function buildMockEnv() {
  const store = {};                       // 本地存储(wx.setStorageSync)
  const outbound = [];                    // 小程序主动发出的所有消息(JSON 字符串)
  const connectedUrls = [];               // connectSocket 用过的 url
  let appGlobal = null;                   // App() 传入的 globalData
  let real = null;                        // 当前活跃的真实底层连接

  const wx = {
    connectSocket({ url, fail }) {
      connectedUrls.push(url);
      const sock = {
        readyState: 0,
        _onOpen: null, _onMsg: null, _onClose: null, _onErr: null,
        send({ data }) {
          outbound.push(String(data));
          if (real && real.readyState === 1) real.send(String(data));
        },
        close({ code = 1000 } = {}) { if (real) try { real.close(code); } catch (e) {} },
        onOpen(cb) { sock._onOpen = cb; },
        onMessage(cb) { sock._onMsg = cb; },
        onClose(cb) { sock._onClose = cb; },
        onError(cb) { sock._onErr = cb; },
      };
      // 打开真实连接
      real = new RealWS(url);
      real.on('open', () => { sock.readyState = 1; if (sock._onOpen) sock._onOpen(); });
      real.on('message', (d) => { if (sock._onMsg) sock._onMsg({ data: d.toString() }); });
      real.on('close', () => { sock.readyState = 3; if (sock._onClose) sock._onClose(); });
      real.on('error', (e) => { if (sock._onErr) sock._onErr(e); });
      sock._real = real;                  // 供测试“模拟断网”直接关闭底层连接
      return sock;
    },
    setStorageSync(k, v) { store[k] = v; },
    getStorageSync(k) { return store[k]; },
  };

  global.wx = wx;
  global.getApp = () => ({ globalData: appGlobal });
  global.App = (o) => { appGlobal = o.globalData; if (typeof o.onLaunch === 'function') o.onLaunch(); };

  return {
    wx, store, outbound, connectedUrls,
    get appGlobal() { return appGlobal; },
    get real() { return real; },
  };
}

module.exports = { buildMockEnv, RealWS };