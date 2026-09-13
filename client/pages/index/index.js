// pages/index/index.js — 战斗页：AprilTag 25h9 实时识别 + 准星瞄准攻击 + 守望先锋式名牌 UI。
//
// 信息可见性（去全知视角）：
// - 面板常显：自己 / 友方队友血量 / 己方基地血量。
// - 敌方玩家、掩体、敌方基地：仅镜头实际扫到标签时在画面上显示名牌；敌方血条只在
//   被我方任一成员命中后揭示 REVEAL_MS（团队共享，再次命中刷新）。
// - 无飘字：命中/击杀反馈为 canvas 命中标记（X）+ 幽灵血条残影 + 震动 + 横幅动效。
const ws = require('../../utils/ws.js');
const detect = require('../../utils/detectWorker.js');

const ROLE_CN = { assault: '突击兵', engineer: '工程师', sniper: '狙击手' };
const BASE_RED = 33, BASE_BLUE = 34;
const BASE_SCAN_CONFIRM_MS = 1000;   // 对准己方基地标签连续识别该时长后自动复活
const FIRE_COOLDOWN_MS = 1000;       // 开火最小间隔（镜像 server/src/protocol.ts FIRE_COOLDOWN_MS，双端同步改）
const REVEAL_MS = 10000;             // 敌方血条揭示时长：我方命中后显示，再命中刷新
const HITMARK_TTL = 400;             // 命中标记存留
const TICK_MS = 100;                 // 动画 ticker：幽灵血条收缩 / 冷却弧 / hitmark 淡出

// 名牌 / 框 / 准星配色（与 app.wxss 面板色一致）
const COL = { red: '#ff5a5a', blue: '#4d9dff', gold: '#e0b84d', green: '#6bd96b' };
const STALE = '#8a8f98';

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
    friends: [],        // Unit[] same faction as me（面板常显）
    enemies: [],        // Unit[] opposite（仅作内部数据/绘制分类，不再有面板）
    bunkers: [],        // Unit[]（同上，仅扫描可见）
    redBase: null,
    blueBase: null,
    basePanels: [],     // 面板常显基地：己方基地（faction 未知时回退红蓝都显）
    respawnRemain: 0,
    respawnReady: false,  // 15s elapsed, awaiting base-tag scan
    scanPct: 0,           // 基地标签连续识别进度 0-100，满格自动复活
    bannerText: '',       // 临时横幅文案（击杀/胜利等）
    bannerClass: '',
    canFire: false,       // 准星套住可攻击目标且不在冷却（驱动快门按钮态）
    fireLabel: '攻击',
    hurtFlash: false,     // 受击红闪（wxml vignette）
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
    this._busySince = 0;   // busy 看门狗：置 busy 的时间戳
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
    this._animTick = null;
    this._unitsById = {};        // id -> Unit（最新快照）
    this._revealedUntil = {};    // 敌方单位 id -> 揭示截止时间戳
    this._dispHp = {};           // 单位 id -> 当前展示血量（幽灵残影，向实际 hp 收缩）
    this._hitmarks = [];         // { tgt, kill, born }
    this._lastShotAt = 0;        // 上次开火时间（冷却）
    this._aim = null;            // 准星当前套住的 { id, unit, attackable }
    this._hurtTimer = null;
    this._bannerTimer = null;
    this._scanSince = null;      // 基地标签开始连续可见的时刻
    this._scanFired = false;     // 本轮瞄准是否已上报复活（防重复发送）
    this._backGuard = false;     // 对局中的返回确认守卫是否已开启

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

    // 动画 ticker：幽灵血条收缩、冷却进度弧、hitmark 淡出补间
    //（检测帧本身也会触发重绘，这里只补帧间动画）。
    this._animTick = setInterval(() => this._tickAnims(), TICK_MS);
  },

  onUnload() {
    this._setBackGuard(false);
    this._teardown();
    (this._unsubs || []).forEach((u) => u && u());
    if (this._respawnTicker) clearInterval(this._respawnTicker);
    if (this._animTick) clearInterval(this._animTick);
    if (this._hurtTimer) { clearTimeout(this._hurtTimer); this._hurtTimer = null; }
    if (this._bannerTimer) { clearTimeout(this._bannerTimer); this._bannerTimer = null; }
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
      this._updateBaseScan();
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
      // busy 看门狗：worker 若因异常没回包，3s 后强制复位，识别不至于永久停摆
      if (this._workerBusy && Date.now() - this._busySince > 3000) this._workerBusy = false;
      if (!this.data.running || !this.data.wasmReady || this._workerBusy) return;
      this._workerBusy = true;
      this._busySince = Date.now();
      this._frameId++;
      detect.post({ type: 'frame', frameId: this._frameId, width: frame.width, height: frame.height, data: frame.data });
    });
    this._listener.start();
  },

  _initCanvas(attempt) {
    const q = this.createSelectorQuery();
    q.select('#overlay').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        // ArkWeb 等环境下 canvas 节点就绪可能偏慢：先重试一次，仍失败则
        // 明确显示（原来这里静默 return，表现为「FPS 正常但永远不画框」）。
        if (!attempt) {
          setTimeout(() => this._initCanvas(1), 800);
        } else {
          this.setData({ statusText: 'overlay canvas 初始化失败（无法画框）' });
        }
        return;
      }
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
        // miss 时按 1 衰减而非清零：低帧率/闪烁检测仍能凑够 3 次净命中；
        // visible 门槛与隐藏逻辑不变，不复活虚线残框。
        t.count = Math.max(0, t.count - 1); t.misses++;
        if (t.misses >= DROP) t.visible = false;   // 灰色虚线宽限期
      }
    }
    // 宽限期（DROP×2 帧无识别）后整条删除，避免残框/ID 冻结在画面上
    for (const id of Object.keys(this._trackers)) {
      if (this._trackers[id].misses >= DROP * 2) delete this._trackers[id];
    }
    for (const id of cur) if (!this._trackers[id]) this._trackers[id] = { id, count: 1, misses: 0, visible: false, lastDet: byId[id] };
  },

  // ---- 绘制 -----
  _drawOverlay() {
    const ctx = this._ctx;
    if (!ctx) return;
    const W = this._canvasW, H = this._canvasH;
    ctx.clearRect(0, 0, W, H);
    if (!this._frameW || !this._frameH) return;
    // Detection coords are already in the screen coordinate space (verified
    // via 5-point calibration: raw frame pct == on-screen position, no
    // rotation/flip/mirror). A plain per-axis scale maps them onto the canvas,
    // which itself is inset:0 over 100vw×100vh — same box as the camera
    // preview. This mirrors the proven implementation in the AprilTag repo.
    const sx = W / this._frameW, sy = H / this._frameH;
    const now = Date.now();
    const myUnit = this.data.myUnit;
    const myId = myUnit?.id;
    const myFaction = myUnit?.faction ?? null;
    const cx0 = W / 2, cy0 = H / 2;
    let aim = null;   // 本帧准星套住的 tracker：{ id, unit, attackable, dist }

    for (const id of Object.keys(this._trackers)) {
      const t = this._trackers[id];
      const d = t.lastDet;
      // 只绘制确认可见的 tracker：未确认的瞬时误检与已丢失的（含闪烁型
      // 误检反复清零 miss 的情况）一律不画，杜绝残框。攻击判定同样只认
      // visible。
      if (!d || !t.visible) continue;
      const unit = this._unitsById[id] || null;

      // 屏幕坐标四角/中心
      const p = [];
      for (let i = 0; i < 4; i++) { p[i] = [d.p[i][0] * sx, d.p[i][1] * sy]; }
      const ccx = d.c[0] * sx, ccy = d.c[1] * sy;
      t._screenX = ccx; t._screenY = ccy;

      // ---- 分类与描边色 ----
      const isMyTag = unit ? unit.id === myId : Number(id) === myId;
      const faction = unit?.faction ?? null;
      const friendly = !!unit && !!myFaction && !isMyTag && faction === myFaction;
      const dead = !!unit && (
        (unit.kind === 'player' && !unit.alive) ||
        (unit.kind === 'bunker' && unit.destroyed) ||
        (unit.kind === 'base' && !unit.alive)
      );
      let stroke = faction === 'red' ? COL.red : faction === 'blue' ? COL.blue : COL.gold;
      if (isMyTag) stroke = COL.green;
      else if (!unit) stroke = '#00ff88';               // 未参战标签
      if (dead || t.misses > 0) stroke = STALE;

      // ---- 四角框 ----
      ctx.globalAlpha = dead ? 0.55 : (t.misses > 0 ? 0.7 : 1);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ---- 名牌（昵称 + 血条/状态徽标，悬于框上方） ----
      if (unit) this._drawNameplate(ctx, unit, p, ccx, { friendly, isMyTag, dead, now });

      // ---- 准星命中测试：屏幕中心是否落在本框内 ----
      if (this._pointInQuad(cx0, cy0, p)) {
        const dist = (ccx - cx0) * (ccx - cx0) + (ccy - cy0) * (ccy - cy0);
        // 可攻击：存活、非己方玩家/基地（掩体无阵营，双方均可打）
        const attackable = !!unit && !dead && !isMyTag && myFaction !== null
          && (unit.kind === 'bunker' || faction !== myFaction);
        if (!aim || dist < aim.dist) aim = { id: unit ? unit.id : Number(id), unit, attackable, dist };
      }
    }

    // ---- 命中标记（X，替代旧飘字） ----
    for (const m of this._hitmarks) {
      const t = this._trackers[String(m.tgt)];
      const x = t ? t._screenX : cx0;   // 开火要求准星套住目标，丢失时中心即弹着点
      const y = t ? t._screenY : cy0;
      const age = Math.min(1, (now - m.born) / HITMARK_TTL);
      const inner = (m.kill ? 7 : 5) + age * (m.kill ? 9 : 6);
      const outer = inner + (m.kill ? 9 : 7);
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = m.kill ? '#ff4b4b' : '#ffffff';
      ctx.lineWidth = m.kill ? 3.5 : 2.5;
      ctx.beginPath();
      ctx.moveTo(x + inner, y + inner); ctx.lineTo(x + outer, y + outer);
      ctx.moveTo(x - inner, y + inner); ctx.lineTo(x - outer, y + outer);
      ctx.moveTo(x + inner, y - inner); ctx.lineTo(x + outer, y - outer);
      ctx.moveTo(x - inner, y - inner); ctx.lineTo(x - outer, y - outer);
      ctx.stroke();
      if (m.kill) {
        ctx.fillStyle = '#ff4b4b';
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // ---- 准星（屏幕中心圆环，套中可攻击目标变红，冷却时画进度弧） ----
    this._drawReticle(ctx, cx0, cy0, aim, now);

    // 缓存准星结果供 attack() 使用；canFire 只在变化时 setData。
    this._aim = aim;
    this._updateCanFire(now);
  },

  // 名牌：昵称（按单位阵营着色）+ 血条（友方恒显；敌方/掩体仅揭示期）或阵亡/摧毁徽标。
  _drawNameplate(ctx, unit, p, ccx, o) {
    const label = unit.kind === 'bunker' ? '掩体 ' + unit.id
      : unit.kind === 'base' ? (unit.faction === 'red' ? '红基地' : '蓝基地')
      : (unit.name || '玩家 ' + unit.id);
    const barColor = unit.faction === 'red' ? COL.red : unit.faction === 'blue' ? COL.blue : COL.gold;
    const nameColor = o.dead ? '#9aa6bd' : o.isMyTag ? COL.green : barColor;

    let minX = Infinity, maxX = -Infinity, minY = Infinity;
    for (const pt of p) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
    }
    const barW = Math.min(120, Math.max(56, maxX - minX));
    const nameH = 17, rowH = o.dead ? 15 : 5, gap = 4;

    ctx.font = 'bold 13px sans-serif';
    const nameW = ctx.measureText(label).width;
    const pillW = nameW + 14;
    const totalW = Math.max(pillW, o.dead ? 60 : barW);
    // 水平夹紧进画布，整体悬于框上方（顶部越界则贴边）
    const cx = Math.min(Math.max(ccx, totalW / 2 + 4), this._canvasW - totalW / 2 - 4);
    const nameTop = Math.max(2, minY - gap - rowH - gap - nameH);

    // 昵称 pill
    this._rr(ctx, cx - pillW / 2, nameTop, pillW, nameH, 4);
    ctx.fillStyle = 'rgba(10,12,18,0.72)';
    ctx.fill();
    ctx.fillStyle = nameColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, nameTop + nameH / 2 + 0.5);

    const rowTop = nameTop + nameH + gap;
    if (o.dead) {
      // 阵亡/摧毁徽标（代替血条）
      const btxt = unit.kind === 'player' ? '已阵亡' : '已摧毁';
      ctx.font = 'bold 11px sans-serif';
      const bw = ctx.measureText(btxt).width + 12;
      this._rr(ctx, cx - bw / 2, rowTop, bw, rowH, 4);
      ctx.fillStyle = 'rgba(10,12,18,0.72)';
      ctx.fill();
      ctx.fillStyle = '#9aa6bd';
      ctx.fillText(btxt, cx, rowTop + rowH / 2 + 0.5);
    } else if (!o.isMyTag && (o.friendly || Date.now() < (this._revealedUntil[unit.id] || 0))) {
      // 血条：深底 + 阵营色填充 + 25% 白刻度 + 幽灵残影（白色，从旧血量收缩）
      const hp = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
      const disp = Math.max(hp, Math.min(1, (this._dispHp[unit.id] ?? unit.hp) / unit.maxHp));
      const bx = cx - barW / 2;
      this._rr(ctx, bx, rowTop, barW, rowH, 2.5);
      ctx.fillStyle = 'rgba(8,10,14,0.8)';
      ctx.fill();
      if (disp > hp) {
        this._rr(ctx, bx + barW * hp, rowTop, barW * (disp - hp), rowH, 2.5);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fill();
      }
      if (hp > 0) {
        this._rr(ctx, bx, rowTop, barW * hp, rowH, 2.5);
        ctx.fillStyle = barColor;
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k <= 3; k++) {
        const tx = bx + (barW * k) / 4;
        ctx.moveTo(tx, rowTop + 0.5); ctx.lineTo(tx, rowTop + rowH - 0.5);
      }
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  },

  _drawReticle(ctx, cx, cy, aim, now) {
    const cdRemain = Math.max(0, FIRE_COOLDOWN_MS - (now - this._lastShotAt));
    const ready = !!aim && aim.attackable && cdRemain === 0;
    const color = cdRemain > 0 ? '#9aa6bd' : ready ? COL.red : (aim ? COL.blue : 'rgba(255,255,255,0.9)');
    const r = ready ? 15 : 12;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
    if (cdRemain > 0) {
      // 装填进度弧：从 12 点方向顺时针填满
      const frac = 1 - cdRemain / FIRE_COOLDOWN_MS;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#ffd56b';
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
    }
  },

  // 圆角矩形路径（不依赖较新的 ctx.roundRect）
  _rr(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  },

  // 射线法：点是否在四边形（屏幕坐标四角）内
  _pointInQuad(px, py, p) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const yi = p[i][1], yj = p[j][1];
      if ((yi > py) !== (yj > py) && px < ((p[j][0] - p[i][0]) * (py - yi)) / (yj - yi) + p[i][0]) {
        inside = !inside;
      }
    }
    return inside;
  },

  // canFire / fireLabel 只在变化时 setData（每帧调用，避免高频渲染通信）
  _updateCanFire(now) {
    now = now || Date.now();
    const u = this.data.myUnit;
    const cdRemain = Math.max(0, FIRE_COOLDOWN_MS - (now - this._lastShotAt));
    const ok = !!(u && u.alive && u.canAttack && this._aim && this._aim.attackable && cdRemain === 0);
    let label = '攻击';
    if (u && !u.alive) label = '阵亡';
    else if (cdRemain > 0) label = '装填中';
    else if (!(this._aim && this._aim.attackable)) label = '瞄准目标';
    if (ok !== this.data.canFire || label !== this.data.fireLabel) {
      this.setData({ canFire: ok, fireLabel: label });
    }
  },

  // ---- 动画 ticker -----
  _tickAnims() {
    if (!this._ctx || !this.data.running) return;
    const now = Date.now();
    // 幽灵血条收缩：每 tick 向实际 hp 递减（回升即复活，已在 _onState 快照时重置）
    let ghost = false;
    for (const id of Object.keys(this._dispHp)) {
      const u = this._unitsById[id];
      if (!u) { delete this._dispHp[id]; continue; }
      if (this._dispHp[id] > u.hp) {
        this._dispHp[id] = Math.max(u.hp, this._dispHp[id] - u.maxHp * 0.2);
        ghost = true;
      }
    }
    if (this._hitmarks.length) {
      this._hitmarks = this._hitmarks.filter((m) => now - m.born < HITMARK_TTL);
    }
    this._updateCanFire(now);
    // 有活跃动画（hitmark / 幽灵残影 / 冷却弧）才补帧重绘；检测帧照常驱动。
    if (this._hitmarks.length || ghost || now - this._lastShotAt < FIRE_COOLDOWN_MS) {
      this._drawOverlay();
    }
  },

  // ---- Attack action -----
  // 开火条件（客户端门控；服务端另有权威校验）：
  // 1) 自己存活可攻击；2) 距上次开火 ≥ FIRE_COOLDOWN_MS；3) 准星套住可攻击目标。
  // 命中范围 = 准星套住的那一个单位（单发单目标）。
  attack() {
    const u = this.data.myUnit;
    if (!u) return;
    if (!u.alive || !u.canAttack) {
      wx.showToast({ title: '已阵亡，无法攻击', icon: 'none' });
      return;
    }
    const now = Date.now();
    if (now - this._lastShotAt < FIRE_COOLDOWN_MS) return;   // 装填中：准星弧线已在提示
    const aim = this._aim;
    if (!aim || !aim.attackable) {
      wx.showToast({ title: '准星未套住可攻击目标', icon: 'none' });
      return;
    }
    this._lastShotAt = now;
    ws.send('attack', { ids: [aim.id] });
    wx.vibrateShort({ type: 'light' });
    this._updateCanFire(now);
    this._drawOverlay();   // 立即刷新准星冷却弧
  },

  // ---- Base-tag scan respawn -----
  // 死亡且复活倒计时结束后，镜头连续 BASE_SCAN_CONFIRM_MS 识别到己方基地
  // 标签（tracker.visible，与攻击判定同一标准）即自动上报复活；识别中断则
  // 进度清零，重新对准可再次触发（服务端冷却为权威，被拒后允许重试）。
  _updateBaseScan() {
    const u = this.data.myUnit;
    if (!u || u.alive || !u.faction || !this.data.respawnReady) { this._resetBaseScan(); return; }
    const baseId = u.faction === 'red' ? BASE_RED : BASE_BLUE;
    const t = this._trackers[String(baseId)];
    if (!t || !t.visible) { this._resetBaseScan(); return; }
    if (this._scanSince == null) {
      this._scanSince = Date.now();
      wx.vibrateShort({ type: 'light' });   // 识别到位提示
    }
    const held = Date.now() - this._scanSince;
    const pct = Math.min(100, Math.round((held / BASE_SCAN_CONFIRM_MS) * 100));
    if (pct !== this.data.scanPct) this.setData({ scanPct: pct });
    if (this._scanFired) return;
    if (held >= BASE_SCAN_CONFIRM_MS) {
      this._scanFired = true;
      wx.vibrateShort({ type: 'medium' });
      ws.send('respawn', { baseId });
    }
  },

  _resetBaseScan() {
    this._scanSince = null;
    this._scanFired = false;
    if (this.data.scanPct) this.setData({ scanPct: 0 });
  },

  // ---- 返回守卫：对局中返回需确认（低版本基础库无此 API 时静默降级） -----
  _setBackGuard(on) {
    if (on === this._backGuard) return;
    this._backGuard = on;
    try {
      if (on) {
        wx.enableAlertBeforeUnload && wx.enableAlertBeforeUnload({ message: '对局进行中，确定返回吗？返回后可从房间页重新进入战斗。' });
      } else {
        wx.disableAlertBeforeUnload && wx.disableAlertBeforeUnload();
      }
    } catch (e) { /* 不支持则忽略 */ }
  },

  // ---- WS state updates -----
  _onState(snapshot, app) {
    app.globalData.room = snapshot;
    const meSummary = snapshot.players.find((p) => p.socketId === app.globalData.me?.socketId) || null;
    const myUnit = snapshot.units.find((u) => u.kind === 'player' && u.socketId === app.globalData.me?.socketId) || null;
    let friends = [], enemies = [], bunkers = [];
    let redBase = null, blueBase = null;
    this._unitsById = {};
    for (const u of snapshot.units) {
      this._unitsById[u.id] = u;
      // 幽灵血量只降不升：hp 回升（复活）直接重置到新值
      if (this._dispHp[u.id] === undefined || this._dispHp[u.id] < u.hp) this._dispHp[u.id] = u.hp;
      if (u.kind === 'player') {
        if (myUnit && u.id === myUnit.id) continue;  // 自己的血条在顶部 HUD，不进友方栏
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

    // 面板只常显己方基地（faction 未知时回退红蓝都显，避免信息缺失）
    let basePanels;
    if (myUnit?.faction === 'red') basePanels = redBase ? [redBase] : [];
    else if (myUnit?.faction === 'blue') basePanels = blueBase ? [blueBase] : [];
    else basePanels = [redBase, blueBase].filter(Boolean);

    const prev = this.data.myUnit;
    this.setData({ snapshot, me: meSummary, myUnit, friends, enemies, bunkers, redBase, blueBase, basePanels });

    // game over → show overlay
    if (snapshot.phase === 'ended' && !this.data.endedOverlay) {
      this.setData({ endedOverlay: true, winnerText: snapshot.winner ? (snapshot.winner + ' 胜利') : '已结束' });
    }

    // 对局进行中开启返回确认，结束后关闭（返回不退出房间，只离开战斗画面）
    this._setBackGuard(snapshot.phase === 'playing');

    // Maintenance: respawn countdown ui
    if (myUnit && !myUnit.alive && myUnit.respawnReadyAt) {
      this._startRespawnTicker(myUnit.respawnReadyAt);
    } else {
      this._stopRespawnTicker();
      this._resetBaseScan();
      if (myUnit) this.setData({ respawnRemain: 0, respawnReady: myUnit.alive ? false : (myUnit.respawnReadyAt == null) });
    }

    // If hp increased unexpectedly (respawn) reset bringup state
    if (prev && myUnit && prev.hp === 0 && myUnit.hp > 0) {
      this.setData({ respawnReady: false });
      this._resetBaseScan();
    }
  },

  _onEvent(env) {
    const e = env.e;
    const myId = this.data.myUnit?.id;
    const myFaction = this.data.myUnit?.faction;
    if (e.t === 'hit') {
      // 团队共享揭示：我方任一成员（含自己）命中非友方目标 → 该目标血条显现
      // REVEAL_MS（掩体 faction 为 null，天然命中此条件；敌方基地同样走 hit）。
      const srcUnit = this._unitsById[e.src];
      const tgtUnit = this._unitsById[e.tgt];
      if (myFaction && srcUnit && srcUnit.faction === myFaction
        && tgtUnit && tgtUnit.faction !== myFaction) {
        this._revealedUntil[e.tgt] = Date.now() + REVEAL_MS;
      }
      // 自己命中 → 命中标记 + 轻震（开火时已震一次，这里为命中确认）
      if (e.src === myId) {
        this._pushHitmark(e.tgt, false);
        wx.vibrateShort({ type: 'light' });
        this._drawOverlay();
      }
      // 自己被打 → 全屏红闪 + 中震（此前受害者无任何反馈）
      if (e.tgt === myId) this._hurt();
    }
    if (e.t === 'kill' && e.src === myId) {
      const name = this._unitsById[e.tgt]?.name;
      this._banner(name ? '已消灭 ' + name : '已消灭', 'kill');
      this._pushHitmark(e.tgt, true);
      wx.vibrateShort({ type: 'heavy' });
    }
    if (e.t === 'playerDown' && e.id === myId) {
      wx.vibrateLong({});   // 阵亡长震；视觉由 dead-overlay 呈现，不再叠横幅
    }
    if (e.t === 'playerRevive' && e.id === myId) {
      this._banner('已复活', 'revive');
    }
    if (e.t === 'bunkerDestroyed' && e.src === myId) {
      this._banner('掩体已摧毁', 'bunker');
      wx.vibrateShort({ type: 'medium' });
    }
    if (e.t === 'gameOver') {
      this.setData({ endedOverlay: true, winnerText: (e.winner === 'red' ? '红方胜利' : '蓝方胜利') });
    }
  },

  // 命中标记：同目标短时间重复命中合并，kill 升级现有标记（白 X → 红 X）
  _pushHitmark(tgtId, kill) {
    const prev = this._hitmarks.find((m) => m.tgt === tgtId && Date.now() - m.born < HITMARK_TTL);
    if (prev) {
      prev.kill = prev.kill || !!kill;
      prev.born = Date.now();
      return;
    }
    this._hitmarks.push({ tgt: tgtId, kill: !!kill, born: Date.now() });
  },

  // 受击反馈：全屏红 vignette（wxml，450ms 自清）+ 震动
  _hurt() {
    wx.vibrateShort({ type: 'medium' });
    if (this._hurtTimer) clearTimeout(this._hurtTimer);
    this.setData({ hurtFlash: true });
    this._hurtTimer = setTimeout(() => {
      this._hurtTimer = null;
      this.setData({ hurtFlash: false });
    }, 450);
  },

  _banner(text, cls) {
    this.setData({ bannerText: text, bannerClass: cls });
    if (this._bannerTimer) clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.setData({ bannerText: '', bannerClass: '' }), cls === 'kill' ? 1200 : 1500);
  },

  // ---- Respawn ticker -----
  _startRespawnTicker(time) {
    if (this._respawnTicker) clearInterval(this._respawnTicker);
    const tick = () => {
      const remain = Math.max(0, Math.ceil((time - Date.now()) / 1000));
      this.setData({ respawnRemain: remain, respawnReady: remain === 0 && !this.data.myUnit?.alive });
      this._updateBaseScan();
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
      this._aim = null;
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
    this._aim = null;
    if (this._unsubWorker) { this._unsubWorker(); this._unsubWorker = null; }
  },

  onCameraError(e) {
    this.setData({ statusText: '摄像头错误: ' + (e.detail && e.detail.errMsg || 'unknown') });
  },
});
