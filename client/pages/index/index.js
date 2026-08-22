// pages/index/index.js — 战斗页：AprilTag 25h9 实时识别 + 攻击按钮 + 战况 UI。
const ws = require('../../utils/ws.js');
const detect = require('../../utils/detectWorker.js');

const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };
const BASE_RED = 34, BASE_BLUE = 35;

Page({
  data: {
    cameraOn: true,
    running: true,
    fps: '0.0',
    wasmReady: false,
    statusText: '正在加载检测引擎…',
    // battle state
    snapshot: null,
    me: null,           // PlayerSummary
    myUnit: null,       // Unit
    friends: [],        // Unit[] red/blue same as me
    enemies: [],        // Unit[] opposite
    bunkers: [],        // Unit[]
    redBase: null,
    blueBase: null,
    respawnRemain: 0,
    respawnReady: false,  // 30s elapsed, awaiting拍基地
    bannerText: '',       // 临时横幅文案（击杀/胜利等）
    bannerClass: '',
    floaters: [],         // 飘字 {id, x, y, text, color, ttl, expires}
    hitTargetId: null,    // 当前帧高亮的被击目标 id (canvas红框)
    endedOverlay: false,
    winnerText: '',
    ROLE_CN,
  },

  onLoad() {
    this._workerBusy = false;
    this._frameId = 0;
    this._fpsCount = 0;
    this._fpsLastTs = Date.now();
    this._trackers = {};
    this._CONFIRM = 3;
    this._DROP = 5;
    this._listener = null;
    this._canvas = null;
    this._ctx = null;
    this._canvasW = 0;
    this._canvasH = 0;
    this._frameW = 0;
    this._frameH = 0;
    this._respawnTicker = null;
    this._floatersTick = null;
    this._myLastHp = null;   // for detecting respawn/round-start shocks

    this._initWorker();
    this._initCamera();
    this._initCanvas();

    // Subscribe to state and events.
    const app = getApp();
    this._unsubs = [
      ws.on('state', (m) => this._onState(m.snapshot, app)),
      ws.on('event', (m) => this._onEvent(m)),
      ws.on('room:error', (m) => wx.showToast({ title: m.message, icon: 'none' })),
      ws.on('room:closed', (m) => {
        wx.showToast({ title: m?.reason || '房间已关闭', icon: 'none', duration: 2000 });
        setTimeout(() => wx.reLaunch({ url: '/pages/lobby/lobby' }), 1500);
      }),
    ];
    // Kick the UI once with the cached snapshot.
    if (app.globalData.room) this._onState(app.globalData.room, app);

    // Floaters ticker — prune expired every 200ms
    this._floatersTick = setInterval(() => this._tickFloaters(), 200);
  },

  onUnload() {
    this._teardown();
    (this._unsubs || []).forEach((u) => u && u());
    if (this._respawnTicker) clearInterval(this._respawnTicker);
    if (this._floatersTick) clearInterval(this._floatersTick);
  },
  onHide() {
    if (this._listener) this._listener.stop();
  },
  onShow() {
    if (this.data.running && this._listener) this._listener.start();
  },

  // ---- WASM worker setup (25h9 fixed) -----
  _initWorker() {
    // 使用全局唯一的 detect worker 单例，订阅其消息（不再各自 createWorker/terminate）。
    this._unsubWorker = detect.subscribe((res) => {
      this._workerBusy = false;
      if (res.type === 'ready') {
        this.setData({ wasmReady: true, statusText: '' });
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
      this._drawOverlay();
    });
  },

  _initCamera() {
    const ctx = wx.createCameraContext(this);
    if (!ctx.onCameraFrame) { this.setData({ statusText: '不支持 onCameraFrame (需 ≥2.7.0)' }); return; }
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

  // ---- Tracker smoothing (unchanged from base) -----
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

    const combatIds = new Set();
    if (this.data.snapshot) {
      for (const u of this.data.snapshot.units) combatIds.add(u.id);
    }

    for (const id of Object.keys(this._trackers)) {
      const t = this._trackers[id];
      const d = t.lastDet;
      if (!d) continue;

      // Is this a "live" combatant?
      const myId = this.data.myUnit?.id;
      const isEnemyUnit = this.data.enemies.some((e) => e.id === Number(id));
      const isFriendUnit = this.data.friends.some((e) => e.id === Number(id));
      const isBunker = this.data.bunkers.some((b) => b.id === Number(id));
      const isBase = Number(id) === BASE_RED || Number(id) === BASE_BLUE;
      const isMyTag = myId === Number(id);

      // Color: enemy=red, friend=blue, base&own=gold/yellow
      let stroke = isFriendUnit ? '#4d9bff' : (isEnemyUnit ? '#ff6b6b' : (isBunker || isBase) ? '#e0b84d' : (isMyTag ? '#6bd96b' : '#00ff88'));
      if (t.misses > 0) stroke = '#888';  // stale

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

      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = '#ffff88';
      ctx.fillText(((isBase && Number(id) === BASE_RED ? '红基地' : isBase ? '蓝基地' : 'id=' + d.id)),
        d.c[0] * sx + 8, d.c[1] * sy - 8);

      // Highlight recently hit target: draw red glow on the overlay
      if (this.data.hitTargetId === Number(id)) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(p[0][0] * sx, p[0][1] * sy);
        for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0] * sx, p[i][1] * sy);
        ctx.closePath();
        ctx.stroke();
      }

      // Floater positions are computed from the *t.current* detection coords
      // (in CSS px). Stored on tracker for the wxml layer.
      t._screenX = d.c[0] * sx;
      t._screenY = d.c[1] * sy;
    }

    // Render floaters on the canvas (so they can drift past overlay bounds)
    const floaters = this.data.floaters || [];
    for (const f of floaters) {
      ctx.font = 'bold 20px sans-serif';
      ctx.globalAlpha = Math.max(0, Math.min(1, (f.expires - Date.now()) / f.ttl));
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - f.lift);
      ctx.globalAlpha = 1;
    }
  },

  // ---- Attack action -----
  attack() {
    if (!this.data.myUnit) return;
    if (!this.data.myUnit.canAttack || !this.data.myUnit.alive) {
      wx.showToast({ title: '已阵亡，无法攻击', icon: 'none' });
      return;
    }
    // Collect.Visible. targets: confirmed trackers only, mask the set of
    // valid enemy units / bunkers / enemy base.
    const ids = [];
    const validIds = new Set();
    {
      const snapshot = this.data.snapshot;
      if (snapshot) {
        for (const u of snapshot.units) {
          if (!u.alive || u.destroyed) continue;
          if (u.faction === this.data.myUnit.faction) {
            // can attack own bunkers only? rule says bq: no own faction player/base
            if (u.kind === 'bunker') validIds.add(u.id);
          } else {
            validIds.add(u.id);
          }
        }
      }
    }
    for (const id of Object.keys(this._trackers)) {
      if (this._trackers[id].visible && validIds.has(Number(id))) {
        ids.push(Number(id));
      }
    }
    if (!ids.length) { wx.showToast({ title: '没有可攻击的目标', icon: 'none' }); return; }
    ws.send('attack', { ids });
    // optimistic local "shoot" feedback
    wx.vibrateShort({ type: 'light' });
  },

  respawnAtBase() {
    if (!this.data.myUnit || !this.data.myUnit.faction) return;
    const baseId = this.data.myUnit.faction === 'red' ? BASE_RED : BASE_BLUE;
    ws.send('respawn', { baseId });
  },

  // ---- WS state updates -----
  _onState(snapshot, app) {
    app.globalData.room = snapshot;
    const meSummary = snapshot.players.find((p) => p.socketId === app.globalData.me?.socketId) || null;
    const myUnit = snapshot.units.find((u) => u.kind === 'player' && u.socketId === app.globalData.me?.socketId) || null;
    let friends = [], enemies = [], bunkers = [];
    let redBase = null, blueBase = null;
    for (const u of snapshot.units) {
      if (u.kind === 'player') {
        if (u.faction === myUnit?.faction) friends.push(u);
        else enemies.push(u);
      } else if (u.kind === 'bunker') bunkers.push(u);
      else if (u.kind === 'base') {
        if (u.faction === 'red') redBase = u; else blueBase = u;
      }
    }
    friends.sort((a, b) => a.id - b.id);
    enemies.sort((a, b) => a.id - b.id);
    bunkers.sort((a, b) => a.id - b.id);

    const prev = this.data.myUnit;
    const wasDead = prev && !prev.alive;
    this.setData({ snapshot, me: meSummary, myUnit, friends, enemies, bunkers, redBase, blueBase });

    // game over → show overlay
    if (snapshot.phase === 'ended' && !this.data.endedOverlay) {
      this.setData({ endedOverlay: true, winnerText: snapshot.winner ? (snapshot.winner + ' 胜利') : '已结束' });
    }

    // Maintenance: respawn countdown ui
    if (myUnit && !myUnit.alive && myUnit.respawnReadyAt) {
      this._startRespawnTicker(myUnit.respawnReadyAt);
    } else {
      this._stopRespawnTicker();
      if (myUnit) this.setData({ respawnRemain: 0, respawnReady: myUnit.alive ? false : (myUnit.respawnReadyAt == null) });
    }

    // If hp increased unexpectedly (respawn) reset bringup state
    if (prev && myUnit && prev.hp === 0 && myUnit.hp > 0) {
      this.setData({ respawnReady: false });
    }
  },

  _onEvent(env) {
    const e = env.e;
    const myId = this.data.myUnit?.id;
    // hit floaters: only the attacker sees "+10" drift above tgt id tracking box
    if (e.t === 'hit' && e.src === myId) {
      // find screen position
      const t = this._trackers[String(e.tgt)];
      const x = t?._screenX ?? this._canvasW / 2;
      const y = t?._screenY ?? this._canvasH / 2;
      const floaters = (this.data.floaters || []).slice();
      floaters.push({ id: Math.random(), x, y, lift: 0, text: '+' + e.dmg, color: '#ffd56b', ttl: 900, expires: Date.now() + 900 });
      this.setData({ floaters, hitTargetId: e.tgt });
      setTimeout(() => { if (this.data.hitTargetId === e.tgt) this.setData({ hitTargetId: null }); }, 800);
    }
    if (e.t === 'kill' && e.src === myId) {
      this._banner('击杀 id' + e.tgt, 'kill');
    }
    if (e.t === 'playerDown' && e.id === myId) {
      this._banner('你被击杀了', 'down');
    }
    if (e.t === 'playerRevive' && e.id === myId) {
      this._banner('已复活', 'revive');
    }
    if (e.t === 'bunkerDestroyed') {
      // Only the shooter banner conditionally
      if (e.src === myId) this._banner('摧毁掩体 id' + e.id, 'bunker');
    }
    if (e.t === 'baseHit') {
      // optional: subtle floaters when attacker
      if (e.src === myId) {
        const t = this._trackers[String(e.id)];
        const x = t?._screenX ?? this._canvasW / 2;
        const y = t?._screenY ?? this._canvasH / 2;
        const floaters = (this.data.floaters || []).slice();
        floaters.push({ id: Math.random(), x, y, lift: 0, text: '-10', color: '#ff8a8a', ttl: 900, expires: Date.now() + 900 });
        this.setData({ floaters, hitTargetId: e.id });
        setTimeout(() => { if (this.data.hitTargetId === e.id) this.setData({ hitTargetId: null }); }, 800);
      }
    }
    if (e.t === 'gameOver') {
      this.setData({ endedOverlay: true, winnerText: (e.winner === 'red' ? '红方胜利' : '蓝方胜利') });
    }
  },

  _banner(text, cls) {
    this.setData({ bannerText: text, bannerClass: cls });
    if (this._bannerTimer) clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.setData({ bannerText: '', bannerClass: '' }), cls === 'kill' ? 1200 : 1500);
  },

  // ---- Floaters tick -----
  _tickFloaters() {
    const f = (this.data.floaters || []).slice();
    for (let i = 0; i < f.length; i++) {
      // lift up over time
      f[i].lift = (50 * (1 - (f[i].expires - Date.now()) / f[i].ttl));
    }
    const kept = f.filter((x) => x.expires > Date.now());
    this.setData({ floaters: kept });
    if (kept.length || this.data.bannerText) this._drawOverlay();
  },

  // ---- Respawn ticker -----
  _startRespawnTicker(time) {
    if (this._respawnTicker) clearInterval(this._respawnTicker);
    const tick = () => {
      const remain = Math.max(0, Math.ceil((time - Date.now()) / 1000));
      this.setData({ respawnRemain: remain, respawnReady: remain === 0 && !this.data.myUnit?.alive });
    };
    tick();
    this._respawnTicker = setInterval(tick, 250);
  },
  _stopRespawnTicker() {
    if (this._respawnTicker) clearInterval(this._respawnTicker);
    this._respawnTicker = null;
  },

  toggle() {
    const running = !this.data.running;
    this.setData({ running });
    if (this._listener) { if (running) this._listener.start(); else this._listener.stop(); }
    if (!running) {
      this._trackers = {};
      const ctx = this._ctx;
      if (ctx) ctx.clearRect(0, 0, this._canvasW, this._canvasH);
    }
  },

  returnToResult() {
    wx.redirectTo({ url: '/pages/result/result' });
  },

  gotoLobby() {
    wx.reLaunch({ url: '/pages/lobby/lobby' });
  },

  // ---- teardown -----
  _teardown() {
    if (this._listener) { try { this._listener.stop(); } catch (e) {} this._listener = null; }
    this._trackers = {};
    if (this._unsubWorker) { this._unsubWorker(); this._unsubWorker = null; }
  },

  onCameraError(e) {
    this.setData({ statusText: '摄像头错误: ' + (e.detail && e.detail.errMsg || 'unknown') });
  },
});