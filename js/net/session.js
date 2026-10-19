/**
 * Shell Gambit — 房间会话
 *
 * 三种模式共用同一套对局驱动（Match）：
 *   · HostSession  房主：拥有权威状态，负责裁剪与广播
 *   · ClientSession 客户端：只发意图，只收自己该看到的视图
 *   · LocalSession  单机人机：完全不走网络
 *
 * 配对流程
 *   客户端广播 HELLO → 房主回 HOST_PRESENT → 客户端发 OFFER → 房主回 ANSWER
 *   → 建立 WebRTC DataChannel（直连）。
 *   任何一步失败都不要紧：对局消息会自动走「中转模式」。
 */

import { LINK, MSG, envelope, makeMsgId, makePeerId } from './protocol.js';
import { SignalBus } from './channels.js';
import { PeerLink } from './rtc.js';
import { Match } from '../game/match.js';
import { pickAiName } from '../ai/ai.js';

/* ---------------------------- 小工具 ---------------------------- */

class Emitter {
  constructor() {
    this._handlers = {};
  }
  on(name, cb) {
    (this._handlers[name] ||= []).push(cb);
    return this;
  }
  emit(name, ...args) {
    for (const cb of this._handlers[name] || []) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`事件 ${name} 处理失败`, e);
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 名字必须是「单字」 */
export function isValidName(name) {
  const chars = [...String(name || '').trim()];
  return chars.length === 1;
}

/**
 * 来自网络的名字一律要在这里洗一遍。
 * 对端可能是有 bug 或恶意的客户端，会发来超长名字甚至 HTML 片段，
 * 房主是唯一的分发源，所以就在这个入口统一裁剪成单字。
 */
function sanitizeName(raw) {
  return [...String(raw ?? '').trim()].slice(0, 1).join('') || '?';
}

/** AI 的思考节奏：联机稍慢一点，让真人看得清 */
const AI_DELAY_NET = 1150;
const AI_DELAY_LOCAL = 800;

/** 状态对账周期：公共通道是 QoS0，状态帧可能丢，靠对账补齐 */
const RECONCILE_MS = 1500;

/**
 * 客户端等回执的耐心值。
 * 超时就一边催房主补发状态、一边重发动作（房主按 actionId 去重），
 * 这样即使丢帧也只停顿一秒多，不会卡到让人以为死机。
 */
const ACTION_RETRY_MS = 1600;

/* ================================================================== *
 * 房主
 * ================================================================== */

export class HostSession extends Emitter {
  /**
   * @param {object} opts
   * @param {string} opts.room
   * @param {{id:string,name:string}} opts.player 房主自己
   */
  constructor({ room, player }) {
    super();
    this.room = room;
    this.me = { id: player.id, name: player.name };
    this.selfId = player.id;
    /** @type {Map<string, object>} peerId → 参与者 */
    this.roster = new Map();
    /** @type {Map<string, PeerLink>} */
    this.links = new Map();
    /** @type {Map<string, {ok:boolean,error?:string,seq:number}>} 动作去重 */
    this.handled = new Map();
    /** @type {Map<string, number>} peerId → 已确认收到的状态帧序号 */
    this.peerAck = new Map();
    this.bus = null;
    this.match = null;
    this.started = false;
    this.busClosedByPolicy = false;
    this.gameStartedAt = 0;
    this.closed = false;

    this.roster.set(this.selfId, {
      id: this.selfId,
      name: this.me.name,
      ready: true,
      isAi: false,
      isHost: true,
      connected: true,
    });
  }

  /** 建立信令通道并开始应答 */
  async open() {
    clearInterval(this.announceTimer);
    this.bus?.close();
    this.bus = new SignalBus({
      room: this.room,
      peerId: this.selfId,
      onMessage: (from, msg, channelId) => this._onBus(from, msg, channelId),
      onStatus: (st) => this.emit('net', { ...st, links: this.linkStatus(), role: 'host' }),
    });
    const n = await this.bus.open();
    if (n === 0) {
      throw new Error('连不上任何公共信令通道，请检查网络后重试');
    }
    this._announce();
    // 每隔几秒再喊一次，方便晚进来的玩家找到房间
    this.announceTimer = setInterval(() => this._announce(), 5000);
    this.emit('lobby', this.lobbyState());
    this.emit('net', { ...this.bus.status(), links: this.linkStatus(), role: 'host' });
    return n;
  }

  _announce() {
    if (this.closed) return;
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: 'all',
      type: MSG.HOST_PRESENT,
      room: this.room,
      started: this.started,
    }));
    // 还没开局时顺便刷新一次大厅名单：
    // 公共通道是 QoS0，客户端万一漏掉了第一次 LOBBY，也能在几秒内补上
    if (!this.started) this._broadcastLobby();
  }

  _signal(to, type, extra) {
    this.bus?.send(to, envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to,
      type,
      ...extra,
    }));
  }

  /** 参与者列表（给 UI 用） */
  lobbyState() {
    return {
      room: this.room,
      selfId: this.selfId,
      isHost: true,
      participants: [...this.roster.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        isAi: p.isAi,
        isHost: p.isHost,
        connected: p.connected,
      })),
    };
  }

  linkStatus() {
    const out = {};
    for (const [id, link] of this.links) out[id] = link.mode;
    return out;
  }

  _broadcastLobby() {
    if (this.closed) return;
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: 'all',
      type: MSG.LOBBY,
      participants: this.lobbyState().participants,
    }));
    this.emit('lobby', this.lobbyState());
  }

  _onBus(from, msg, channelId) {
    if (this.closed) return;
    switch (msg.type) {
      case MSG.HELLO: {
        this._addPeer(from, msg.name);
        this._signal(from, MSG.HOST_PRESENT, { room: this.room, started: this.started });
        this._broadcastLobby();
        break;
      }
      case MSG.OFFER: {
        const link = this._ensureLink(from);
        link.handleOffer(msg.sdp);
        break;
      }
      case MSG.ANSWER:
        this.links.get(from)?.handleAnswer(msg.sdp);
        break;
      case MSG.ICE:
        this.links.get(from)?.handleIce(msg.candidate);
        break;
      case MSG.BYE: {
        this._removePeer(from, '对方离开了房间');
        break;
      }
      // --- 对局消息（中转模式会从这里进来）---
      case MSG.ACTION:
        this._handleAction(from, msg);
        break;
      case MSG.REACTION:
        this._handleReaction(from, msg);
        break;
      case MSG.REMATCH:
        this._handleRematch(from);
        break;
      case MSG.STATE_ACK:
        if (typeof msg.seq === 'number') this.peerAck.set(from, msg.seq);
        break;
      case MSG.STATE_REQ:
        // 客户端说没收到，立刻补发一次（幂等）
        this._sendStateTo(from);
        break;
      default:
        break;
    }
  }

  _addPeer(peerId, rawName) {
    const name = sanitizeName(rawName);
    const existing = this.roster.get(peerId);
    if (existing) {
      if (existing.name !== name) {
        existing.name = name;
        this._broadcastLobby();
      }
      return;
    }
    if (this.roster.size >= 4) {
      // 满员：告知对方
      this._signal(peerId, MSG.BYE, { reason: '房间已满' });
      return;
    }
    this.roster.set(peerId, {
      id: peerId,
      name,
      ready: true, // 进来就是要玩的，直接算已准备
      isAi: false,
      isHost: false,
      connected: true,
    });
    this._ensureLink(peerId);
    this.emit('toast', `${name} 加入了房间`);
  }

  _removePeer(peerId, reason) {
    const p = this.roster.get(peerId);
    if (!p) return;
    this.roster.delete(peerId);
    this.links.get(peerId)?.close();
    this.links.delete(peerId);
    this.emit('toast', `${p.name} 离开了${reason ? `（${reason}）` : ''}`);
    if (this.match && this.match.state.phase === 'playing') {
      // 对局中掉线：交给 AI 接管，别让整局卡住
      this.match.setAi(peerId, true);
      this._broadcastState();
    }
    this._broadcastLobby();
  }

  _ensureLink(peerId) {
    let link = this.links.get(peerId);
    if (link) return link;
    link = new PeerLink({
      selfId: this.selfId,
      peerId,
      isHost: true,
      signalOut: (to, m) => this._signal(to, m.type, m),
      relayOut: (to, m) => this.bus?.send(to, m),
      onMessage: (from, m) => this._onPeerMessage(from, m),
      onModeChange: (id, mode) => this._onLinkMode(id, mode),
    });
    this.links.set(peerId, link);
    return link;
  }

  _onLinkMode(peerId, mode) {
    this.emit('net', { ...(this.bus?.status() || { open: 0, channels: [] }), links: this.linkStatus(), role: 'host' });
    if (mode === LINK.DIRECT) {
      this._maybeCloseBus();
      // 刚建立直连，补发一次完整状态
      this._sendStateTo(peerId);
    } else if (mode === LINK.RELAY) {
      this._reopenBusIfNeeded();
      this._sendStateTo(peerId);
    }
  }

  /**
   * 所有人都直连之后，就把公共信令通道关掉。
   * 这直接满足「配对成功后不依赖任何服务器，断信令不影响对局」。
   */
  _maybeCloseBus() {
    if (!this.started || this.busClosedByPolicy || this.closed) return;
    if (Date.now() - this.gameStartedAt < 8000) return; // 留一点缓冲
    const peers = [...this.roster.keys()].filter((id) => id !== this.selfId);
    if (!peers.length) return;
    for (const id of peers) {
      if (!this.links.get(id)?.isDirect) return; // 还有人走中转，不能关
    }
    this.busClosedByPolicy = true;
    this.bus?.close();
    this.emit('toast', '全部 P2P 直连成功，已断开公共信令');
    this.emit('net', { open: 0, channels: [], links: this.linkStatus(), role: 'host', closed: true });
  }

  _reopenBusIfNeeded() {
    if (!this.busClosedByPolicy || this.closed) return;
    this.busClosedByPolicy = false;
    this.open().catch(() => {});
  }

  /** 收到来自某个 peer 的对局消息（直连或中转） */
  _onPeerMessage(from, msg) {
    switch (msg.type) {
      case MSG.ACTION:
        this._handleAction(from, msg);
        break;
      case MSG.REACTION:
        this._handleReaction(from, msg);
        break;
      case MSG.PING:
        this._sendTo(from, envelope({ id: makeMsgId(this.selfId), from: this.selfId, to: from, type: MSG.PONG }));
        break;
      case MSG.STATE_REQ:
        this._sendStateTo(from);
        break;
      case MSG.HELLO:
        this._addPeer(from, msg.name);
        this._sendTo(from, envelope({
          id: makeMsgId(this.selfId), from: this.selfId, to: from, type: MSG.HOST_PRESENT, room: this.room, started: this.started,
        }));
        break;
      default:
        break;
    }
  }

  /** 给某个 peer 发消息：优先直连，否则中转 */
  _sendTo(peerId, msg) {
    if (this.closed) return null;
    const link = this.links.get(peerId);
    if (link) return link.send(msg);
    if (this.bus) {
      this.bus.send(peerId, msg);
      return LINK.RELAY;
    }
    return null;
  }

  /* ------------------------- 大厅操作 ------------------------- */

  /** 房主一键补位：加一个 AI */
  addAi() {
    if (this.started) return;
    if (this.roster.size >= 4) return;
    const used = [...this.roster.values()].map((p) => p.name);
    let name = pickAiName(used);
    let guard = 0;
    while (used.includes(name) && guard++ < 40) name = pickAiName(used);
    const id = `ai-${makePeerId()}`;
    this.roster.set(id, {
      id, name, ready: true, isAi: true, isHost: false, connected: true,
    });
    this._broadcastLobby();
  }

  /** 移除一个 AI（真人不能由房主移除，只能自己退出） */
  removeAi(id) {
    const p = this.roster.get(id);
    if (!p || !p.isAi || this.started) return;
    this.roster.delete(id);
    this._broadcastLobby();
  }

  setReady(id, ready) {
    const p = this.roster.get(id);
    if (!p || p.isAi) return;
    p.ready = !!ready;
    this._broadcastLobby();
  }

  /** 是否可以开局：2–4 名参与者即可（房主可随时开始） */
  canStart() {
    const n = this.roster.size;
    return n >= 2 && n <= 4;
  }

  /* ------------------------- 对局 ------------------------- */

  /** 开始对局（房主触发） */
  beginGame() {
    if (this.started || !this.canStart()) return false;
    const list = [...this.roster.values()];
    this._startMatch(list);
    return true;
  }

  _startMatch(list) {
    this.match?.dispose();
    this.handled.clear();
    this.peerAck.clear();
    this.started = true;
    this.gameStartedAt = Date.now();

    this.match = new Match({
      players: list.map((p) => ({ id: p.id, name: p.name, isAi: p.isAi })),
      aiDelayMs: AI_DELAY_NET,
      onUpdate: () => this._onMatchUpdate(),
    });

    const payload = {
      players: this.match.state.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
      aiIds: list.filter((p) => p.isAi).map((p) => p.id),
      // 注意：绝不能把 seed 发给客户端 —— 拿到 seed 就能复现洗牌、推出弹序
    };
    // 通过公共通道广播一次（保证中转模式的玩家也能收到）
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.START, ...payload,
    }));
    for (const p of list) {
      if (p.isAi || p.isHost) continue;
      this._sendTo(p.id, envelope({
        id: makeMsgId(this.selfId), from: this.selfId, to: p.id, type: MSG.START, ...payload,
      }));
    }
    this.emit('start', payload);
    this.match.start();

    // 状态对账：公共通道可能丢帧，定期把落后的人补齐，保证永远不会卡在旧状态
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => this._reconcile(), RECONCILE_MS);
  }

  /** 把还没确认到最新帧的客户端补齐 */
  _reconcile() {
    if (this.closed || !this.match) return;
    const seq = this.match.state.seq;
    for (const id of this.roster.keys()) {
      if (id === this.selfId) continue;
      const p = this.roster.get(id);
      if (!p || p.isAi) continue;
      const ack = this.peerAck.get(id);
      if (ack === undefined || ack < seq) this._sendStateTo(id);
    }
  }

  _onMatchUpdate() {
    if (this.closed || !this.match) return;
    this._broadcastState();
    this._maybeCloseBus();
    const st = this.match.state;
    if (st.phase === 'over') {
      const payload = {
        winner: st.winner,
        players: st.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, alive: p.alive, hp: p.hp })),
      };
      this.bus?.send('all', envelope({
        id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.OVER, ...payload,
      }));
      for (const id of this.roster.keys()) {
        if (id === this.selfId) continue;
        this._sendTo(id, envelope({
          id: makeMsgId(this.selfId), from: this.selfId, to: id, type: MSG.OVER, ...payload,
        }));
      }
      this.emit('over', payload);
    }
  }

  _broadcastState() {
    if (!this.match) return;
    for (const id of this.roster.keys()) {
      if (id === this.selfId) continue;
      this._sendStateTo(id);
    }
    this.emit('state', this.match.viewFor(this.selfId));
  }

  _sendStateTo(peerId) {
    if (!this.match) return;
    const p = this.roster.get(peerId);
    if (!p || p.isAi) return;
    const view = this.match.viewFor(peerId);
    this._sendTo(peerId, envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: peerId,
      type: MSG.STATE,
      view,
    }));
  }

  /** 客户端请求一个动作 */
  _handleAction(from, msg) {
    if (!this.match) return;
    // 同一条动作重复送达（重发 / 双通道）时，直接回放上次结果
    if (msg.actionId && this.handled.has(msg.actionId)) {
      const prev = this.handled.get(msg.actionId);
      this._sendTo(from, envelope({
        id: makeMsgId(this.selfId), from: this.selfId, to: from,
        type: MSG.ACTION_ACK, actionId: msg.actionId, ...prev,
      }));
      return;
    }
    const res = this.match.submit(from, msg.action);
    const record = { ok: res.ok, error: res.error || null, seq: this.match.state.seq };
    if (msg.actionId) {
      this.handled.set(msg.actionId, record);
      if (this.handled.size > 200) {
        this.handled.delete(this.handled.keys().next().value);
      }
    }
    this._sendTo(from, envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: from,
      type: MSG.ACTION_ACK, actionId: msg.actionId, ...record,
    }));
    if (!res.ok && res.error) this.emit('toast', `${this.roster.get(from)?.name || '玩家'} 的动作被拒绝：${res.error}`);
  }

  /** 房主自己的操作 */
  submitLocal(action) {
    if (!this.match) return { ok: false, error: '对局还没开始' };
    return this.match.submit(this.selfId, action);
  }

  /* ------------------------- 互动 ------------------------- */

  _handleReaction(from, msg) {
    this._broadcastReaction({ kind: msg.kind, from, targetId: msg.targetId });
  }

  /** 扔鲜花 / 鸡蛋 */
  react(kind, toId) {
    this._broadcastReaction({ kind, from: this.selfId, targetId: toId });
  }

  _broadcastReaction(payload) {
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.REACTION, ...payload,
    }));
    for (const id of this.roster.keys()) {
      if (id === this.selfId) continue;
      this._sendTo(id, envelope({
        id: makeMsgId(this.selfId), from: this.selfId, to: id, type: MSG.REACTION, ...payload,
      }));
    }
    this.emit('reaction', payload);
  }

  /* ------------------------- 再来一局 ------------------------- */

  _handleRematch(from) {
    const p = this.roster.get(from);
    if (p) p.ready = true;
    this._broadcastLobby();
    this.emit('toast', `${p?.name || '玩家'} 想再来一局`);
  }

  requestRematch() {
    if (!this.match) return;
    const list = [...this.roster.values()];
    if (list.length < 2) return;
    this._startMatch(list);
  }

  close() {
    this.closed = true;
    clearInterval(this.announceTimer);
    clearInterval(this.reconcileTimer);
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.BYE, reason: '房主关闭了房间',
    }));
    this.match?.dispose();
    for (const l of this.links.values()) l.close();
    this.links.clear();
    this.bus?.close();
  }
}

/* ================================================================== *
 * 客户端
 * ================================================================== */

export class ClientSession extends Emitter {
  constructor({ room, player }) {
    super();
    this.room = room;
    this.me = { id: player.id, name: player.name };
    this.selfId = player.id;
    this.hostId = null;
    this.bus = null;
    this.link = null;
    this.started = false;
    this.pendingAction = null;
    this.retryTimer = null;
    this.lastSeq = -1;
    this.lastStateAt = 0;
    this.watchdogTimer = null;
    this.closed = false;
    this.participants = [];
    this.rejectedReason = null;
  }

  /** 打开信令通道并寻找房主 */
  async open() {
    this.bus = new SignalBus({
      room: this.room,
      peerId: this.selfId,
      onMessage: (from, msg) => this._onBus(from, msg),
      onStatus: (st) => this.emit('net', { ...st, hostId: this.hostId, linkMode: this.link?.mode, role: 'client' }),
    });
    const n = await this.bus.open();
    if (n === 0) throw new Error('连不上任何公共信令通道，请检查网络后重试');

    await this._findHost();
    this.emit('net', { ...this.bus.status(), hostId: this.hostId, linkMode: this.link?.mode, role: 'client' });

    // 兜底看门狗：万一把状态帧丢了（公网通道是 QoS0），
    // 每 4 秒主动催一次，保证永远不会停在旧画面上
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (this.closed || !this.started) return;
      if (Date.now() - this.lastStateAt < 4000) return;
      this._requestState();
    }, 4000);

    return n;
  }

  async _findHost() {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !this.hostId && !this.closed && !this.rejectedReason) {
      this.bus.send('all', envelope({
        id: makeMsgId(this.selfId),
        from: this.selfId,
        to: 'all',
        type: MSG.HELLO,
        name: this.me.name,
        room: this.room,
      }));
      await sleep(1600);
    }
    if (this.rejectedReason) throw new Error(this.rejectedReason);
    if (!this.hostId) {
      throw new Error(`没有找到房间 ${this.room}，请确认房间号是否正确、房主是否已建房`);
    }
  }

  _onBus(from, msg) {
    if (this.closed) return;
    switch (msg.type) {
      case MSG.HOST_PRESENT: {
        if (this.hostId && this.hostId !== from) {
          // 同一个房间号出现了第二个房主，忽略后到的
          return;
        }
        if (msg.started) {
          // 对局已经开打，不再放人进来，避免出现观战/状态不一致
          this.rejectedReason = '该房间的对局已经开始，请让房主重新建房';
          return;
        }
        if (!this.hostId) {
          this.hostId = from;
          this._startPeerLink();
        }
        break;
      }
      case MSG.ANSWER:
        this.link?.handleAnswer(msg.sdp);
        break;
      case MSG.ICE:
        this.link?.handleIce(msg.candidate);
        break;
      case MSG.LOBBY:
        this.participants = msg.participants || [];
        this.emit('lobby', {
          room: this.room,
          selfId: this.selfId,
          isHost: false,
          participants: this.participants,
        });
        break;
      case MSG.START:
        this.started = true;
        this.emit('start', msg);
        break;
      case MSG.STATE:
        this._onState(msg.view);
        break;
      case MSG.OVER:
        this.emit('over', msg);
        break;
      case MSG.REACTION:
        this.emit('reaction', { kind: msg.kind, from: msg.from, targetId: msg.targetId });
        break;
      case MSG.BYE: {
        if (from === this.hostId) {
          this.emit('closed', msg.reason || '房主离开了房间');
        } else if (!this.hostId && msg.reason) {
          // 还没连上就被房主拒之门外（房间已满等）。原因来自网络，截断后再展示
          this.rejectedReason = String(msg.reason).slice(0, 60);
        } else {
          this.emit('toast', '有玩家离开了房间');
        }
        break;
      }
      case MSG.ACTION_ACK: {
        if (this.pendingAction && msg.actionId === this.pendingAction.actionId) {
          if (!msg.ok) {
            this.pendingAction = null;
            clearTimeout(this.retryTimer);
            this.emit('toast', `动作被拒绝：${msg.error}`);
            this.emit('pending', null);
          }
        }
        break;
      }
      case MSG.PING:
        this._send({
          id: makeMsgId(this.selfId), from: this.selfId, to: this.hostId, type: MSG.PONG,
        });
        break;
      default:
        break;
    }
  }

  _onPeerMessage(from, msg) {
    this._onBus(from, msg);
  }

  _startPeerLink() {
    if (this.link) return;
    // 已经找到房主后再喊一声，确保大厅名单一定能拿到
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.HELLO, name: this.me.name, room: this.room,
    }));
    this.link = new PeerLink({
      selfId: this.selfId,
      peerId: this.hostId,
      isHost: false,
      signalOut: (to, m) => this.bus?.send(to, envelope({
        id: makeMsgId(this.selfId), from: this.selfId, to, type: m.type, ...m,
      })),
      relayOut: (to, m) => this.bus?.send(to, m),
      onMessage: (from, m) => this._onPeerMessage(from, m),
      onModeChange: (id, mode) => {
        this.emit('net', { ...(this.bus?.status() || { open: 0, channels: [] }), hostId: this.hostId, linkMode: mode, role: 'client' });
        this.emit('toast', mode === LINK.DIRECT ? 'P2P 直连成功' : '网络受限，已切换为中转模式');
      },
    });
    this.link.startAsOfferer();
    this.emit('net', { ...(this.bus?.status() || { open: 0, channels: [] }), hostId: this.hostId, linkMode: this.link.mode, role: 'client' });
  }

  _onState(view) {
    if (!view) return;
    if (view.seq < this.lastSeq) return; // 旧消息，忽略
    this.lastSeq = view.seq;
    this.lastStateAt = Date.now();
    // 回执：房主据此知道谁还落后，丢帧时会把状态补齐
    this._send(envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: this.hostId,
      type: MSG.STATE_ACK,
      seq: view.seq,
    }));
    // 状态推进说明动作已被受理
    if (this.pendingAction && view.seq > this.pendingAction.seq) {
      this.pendingAction = null;
      clearTimeout(this.retryTimer);
      this.emit('pending', null);
    }
    this.emit('state', view);
  }

  /** 发消息给房主：优先直连，否则中转 */
  _send(msg) {
    if (this.link) return this.link.send(msg);
    if (this.bus) {
      this.bus.send(msg.to, msg);
      return LINK.RELAY;
    }
    return null;
  }

  /** 提交一个操作 */
  submit(action) {
    if (!this.started) return { ok: false, error: '对局还没开始' };
    if (!this.hostId) return { ok: false, error: '还没连上房主' };
    if (this.pendingAction) return { ok: false, error: '上一个操作还在处理中' };
    const actionId = `${this.selfId}-a${Date.now().toString(36)}`;
    const record = { actionId, action, seq: this.lastSeq, tries: 0 };
    this.pendingAction = record;
    this._sendAction(record);
    this.emit('pending', record);
    return { ok: true };
  }

  _sendAction(record) {
    record.tries += 1;
    this._send(envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: this.hostId,
      type: MSG.ACTION,
      actionId: record.actionId,
      action: record.action,
    }));
    clearTimeout(this.retryTimer);
    // 只重试 2 次：再久就该让玩家重来了，绝不能让人对着"等待中"干等
    if (record.tries < 3) {
      // 公共通道是 QoS0，可能丢；没收到新状态就重发。房主按 actionId 去重。
      this.retryTimer = setTimeout(() => {
        if (this.pendingAction !== record || this.closed) return;
        // 先催一次状态：如果动作其实已经被执行、只是结果帧丢了，
        // 房主补发的状态就会让 pending 立刻解除，不用重复执行动作
        this._requestState();
        this._sendAction(record);
      }, ACTION_RETRY_MS);
    } else {
      this.retryTimer = setTimeout(() => {
        if (this.pendingAction === record && !this.closed) {
          this.pendingAction = null;
          this.emit('pending', null);
          this.emit('toast', '操作似乎没有送达，请再点一次');
        }
      }, ACTION_RETRY_MS);
    }
  }

  /** 请房主立刻补发当前状态 */
  _requestState() {
    if (!this.hostId) return;
    this._send(envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: this.hostId,
      type: MSG.STATE_REQ,
    }));
  }

  react(kind, toId) {
    if (!this.hostId) return;
    this._send(envelope({
      id: makeMsgId(this.selfId),
      from: this.selfId,
      to: this.hostId,
      type: MSG.REACTION,
      kind,
      targetId: toId,
    }));
  }

  requestRematch() {
    if (!this.hostId) return;
    this._send(envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: this.hostId, type: MSG.REMATCH,
    }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdogTimer);
    this.bus?.send('all', envelope({
      id: makeMsgId(this.selfId), from: this.selfId, to: 'all', type: MSG.BYE, name: this.me.name,
    }));
    this.link?.close();
    this.bus?.close();
  }
}

/* ================================================================== *
 * 单机人机
 * ================================================================== */

export class LocalSession extends Emitter {
  /**
   * @param {object} opts
   * @param {{id:string,name:string}} opts.player
   * @param {number} opts.aiCount 1–3
   */
  constructor({ player, aiCount }) {
    super();
    this.me = { id: player.id, name: player.name };
    this.selfId = player.id;
    this.aiCount = Math.max(1, Math.min(3, aiCount));
    this.match = null;
    this.closed = false;
  }

  start() {
    const used = [this.me.name];
    const players = [{ id: this.selfId, name: this.me.name, isAi: false }];
    for (let i = 0; i < this.aiCount; i++) {
      let name = pickAiName(used);
      let guard = 0;
      while (used.includes(name) && guard++ < 40) name = pickAiName(used);
      used.push(name);
      players.push({ id: `ai-${i}-${Math.random().toString(36).slice(2, 7)}`, name, isAi: true });
    }
    this.match = new Match({
      players,
      aiDelayMs: AI_DELAY_LOCAL,
      onUpdate: () => this._onUpdate(),
    });
    this.participants = players.map((p) => ({
      id: p.id, name: p.name, ready: true, isAi: !!p.isAi, isHost: p.id === this.selfId, connected: true,
    }));
    this.emit('start', {
      players: this.match.state.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
      aiIds: players.filter((p) => p.isAi).map((p) => p.id),
    });
    this.match.start();
  }

  _onUpdate() {
    if (this.closed) return;
    this.emit('state', this.match.viewFor(this.selfId));
    if (this.match.state.phase === 'over') {
      const st = this.match.state;
      this.emit('over', {
        winner: st.winner,
        players: st.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, alive: p.alive, hp: p.hp })),
      });
    }
  }

  submit(action) {
    if (!this.match) return { ok: false, error: '对局还没开始' };
    return this.match.submit(this.selfId, action);
  }

  requestRematch() {
    if (this.closed) return;
    this.match?.dispose();
    this.match = null;
    this.start();
  }

  close() {
    this.closed = true;
    this.match?.dispose();
  }
}