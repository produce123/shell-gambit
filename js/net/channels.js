/**
 * Shell Gambit — 公共信令总线（无后端房间号匹配）
 *
 * 项目没有任何服务器，房间号匹配靠「公共信令通道」完成：
 *   · MQTT over WSS（HiveMQ 等公共 broker，免鉴权）
 *   · ntfy.sh（HTTP POST 发布 / WebSocket 订阅，CORS 全开）
 *
 * 多个通道同时收发，按消息 id 去重；任何一条活着配对就能成功。
 *
 * 为什么要「波浪式」连接而不是一次全连：
 *   公共 broker 普遍限制同一 IP 的并发连接数，一次开五六条反而会被踢下线，
 *   结果每个人活下来的通道各不相同、反而互相收不到消息。
 *   所以这里一次只并发尝试 2 条，够用即停。
 *
 * 主题命名（只订阅「广播」与「发给我的」，绝不订阅通配符，
 * 否则会收到别人的私有视图，等于泄露手牌情报）
 *   MQTT: shellgambit/1/<房间号>/all 与 /p/<peerId>
 *   ntfy: shellgambit-1-<房间号>-all 与 -<peerId>
 */

import { MQTT_BROKERS, MqttClient } from './mqtt.js';
import { PROTOCOL_VERSION } from './protocol.js';

const TOPIC_ROOT = 'shellgambit';
const NTFY_WS = 'wss://ntfy.sh';
const NTFY_HTTP = 'https://ntfy.sh';

/* ---------------------------- MQTT 通道 ---------------------------- */

class MqttChannel {
  constructor(id, url, { peerId, room, onMessage, onStatus }) {
    this.kind = 'mqtt';
    this.id = id;
    this.label = new URL(url).host;
    this.url = url;
    this.prefix = `${TOPIC_ROOT}/${PROTOCOL_VERSION}/${room}`;
    this.peerId = peerId;
    this.onMessage = onMessage;
    this.client = new MqttClient(url, {
      clientId: `sg-${peerId}-${Math.random().toString(36).slice(2, 7)}`,
      onMessage: (topic, payload) => {
        // 自己发的消息会回环回来，靠上层按 id 去重
        this.onMessage(this.id, payload);
      },
      onStatus,
    });
  }

  get connected() {
    return this.client.connected;
  }

  async connect(timeoutMs) {
    const ok = await this.client.connect(timeoutMs);
    if (!ok) return false;
    this.client.subscribe(this.topicFor('all'));
    this.client.subscribe(this.topicFor(this.peerId));
    return true;
  }

  topicFor(to) {
    return to === 'all' ? `${this.prefix}/all` : `${this.prefix}/p/${to}`;
  }

  publish(to, payload) {
    return this.client.publish(this.topicFor(to), payload);
  }

  close() {
    this.client.close();
  }
}

/* ---------------------------- ntfy 通道 ---------------------------- */

class NtfyChannel {
  constructor(id, { peerId, room, onMessage, onStatus }) {
    this.kind = 'ntfy';
    this.id = id;
    this.label = 'ntfy.sh';
    this.base = `${TOPIC_ROOT}-${PROTOCOL_VERSION}-${room}`;
    this.peerId = peerId;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.connected = false;
    this.closedByUs = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    /** @type {{to:string,payload:string,key:string}[]} */
    this.queue = [];
    this.queueTimer = null;
    // ntfy 免费额度对请求频率有限制，所以限速 + 同键合并
    this.minIntervalMs = 1100;
  }

  topicFor(to) {
    return to === 'all' ? `${this.base}-all` : `${this.base}-${to}`;
  }

  connect(timeoutMs) {
    return this._attempt(timeoutMs);
  }

  _attempt(timeoutMs) {
    if (this.closedByUs) return Promise.resolve(false);
    const mine = this.topicFor(this.peerId);
    const all = this.topicFor('all');
    // since=none：只要新消息，避免把历史缓存当成当前消息
    const url = `${NTFY_WS}/${all},${mine}/ws?since=none`;
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try {
          this.ws?.close();
        } catch {
          /* 忽略 */
        }
        done(false);
      }, timeoutMs);
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        return done(false);
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        this.onStatus('open');
        done(true);
      };
      ws.onerror = () => {
        this.onStatus('error', '连接出错');
      };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        if (!this.closedByUs) {
          this.onStatus('closed');
          this._scheduleReconnect();
        }
        if (!was) done(false);
      };
      ws.onmessage = (ev) => {
        let data;
        try {
          data = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (data && data.event === 'message' && typeof data.message === 'string') {
          this.onMessage(this.id, data.message);
        }
      };
    });
  }

  _scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 12000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByUs || this.connected) return;
      await this._attempt(9000);
      if (!this.connected && !this.closedByUs) this._scheduleReconnect();
    }, delay);
  }

  publish(to, payload) {
    if (!this.connected) return false;
    // 同一个接收者 + 同一种消息只保留最新一条（状态帧可以被覆盖）
    let type = '';
    try {
      type = JSON.parse(payload).type || '';
    } catch {
      /* 忽略 */
    }
    const key = `${to}:${type}`;
    this.queue = this.queue.filter((q) => q.key !== key);
    this.queue.push({ to, payload, key });
    if (this.queue.length > 40) this.queue.splice(0, this.queue.length - 40);
    this.flushSoon();
    return true;
  }

  flushSoon() {
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.flushOne();
    }, this.minIntervalMs);
  }

  flushOne() {
    const item = this.queue.shift();
    if (!item) return;
    fetch(`${NTFY_HTTP}/${this.topicFor(item.to)}`, { method: 'POST', body: item.payload }).catch(() => {
      /* 单次失败无所谓：状态会被后续消息覆盖 */
    });
    if (this.queue.length) this.flushSoon();
  }

  close() {
    this.closedByUs = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    if (this.queueTimer) clearTimeout(this.queueTimer);
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------------------------- 总线 ---------------------------- */

export class SignalBus {
  /**
   * @param {object} opts
   * @param {string} opts.room
   * @param {string} opts.peerId
   * @param {(fromPeer:string, msg:object, channelId:string)=>void} opts.onMessage
   * @param {(status:object)=>void} [opts.onStatus]
   */
  constructor({ room, peerId, onMessage, onStatus }) {
    this.room = room;
    this.peerId = peerId;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    /** @type {(MqttChannel|NtfyChannel)[]} */
    this.channels = [];
    this.seen = new Set();
    this.seenOrder = [];
    this.closed = false;
  }

  _mkMqtt(i) {
    return () =>
      new MqttChannel(`mqtt${i}`, MQTT_BROKERS[i], {
        peerId: this.peerId,
        room: this.room,
        onMessage: (id, payload) => this._receive(id, payload),
        onStatus: (state, detail) => this._status(`mqtt${i}`, state, detail),
      });
  }

  _mkNtfy() {
    return () =>
      new NtfyChannel('ntfy', {
        peerId: this.peerId,
        room: this.room,
        onMessage: (id, payload) => this._receive(id, payload),
        onStatus: (state, detail) => this._status('ntfy', state, detail),
      });
  }

  /**
   * 波浪式连接：一次并发最多 2 条，够用即停。
   * 返回当前可用通道数（0 表示彻底连不上）。
   */
  async open({ timeoutMs = 6000 } = {}) {
    const waves = [
      [this._mkMqtt(0), this._mkNtfy()],
      [this._mkMqtt(1), this._mkMqtt(2)],
      [this._mkMqtt(3), this._mkMqtt(4)],
    ];
    for (const wave of waves) {
      if (this.closed) break;
      const ok = await this._runWave(wave, timeoutMs);
      if (ok > 0) break;
    }
    this.onStatus(this.status());
    return this.openCount;
  }

  /** 跑一波：任意一条成功就立刻返回，其余留在后台继续连 */
  _runWave(makers, timeoutMs) {
    return new Promise((resolve) => {
      let settled = 0;
      for (const make of makers) {
        const ch = make();
        ch.state = 'connecting';
        this.channels.push(ch);
        ch.connect(timeoutMs).then((success) => {
          settled += 1;
          ch.state = success ? 'open' : 'failed';
          if (success) {
            this.onStatus(this.status());
            resolve(1);
          } else {
            this.channels = this.channels.filter((c) => c !== ch);
            try {
              ch.close();
            } catch {
              /* 忽略 */
            }
            if (settled === makers.length) resolve(0);
          }
        });
      }
    });
  }

  /** 当前可用通道数 */
  get openCount() {
    return this.channels.filter((c) => c.connected).length;
  }

  status() {
    return {
      open: this.openCount,
      channels: this.channels.map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind,
        state: c.connected ? 'open' : c.state === 'connecting' ? 'connecting' : 'closed',
      })),
    };
  }

  _status(id, state, detail) {
    const ch = this.channels.find((c) => c.id === id);
    if (ch) ch.state = state === 'open' ? 'open' : 'closed';
    this.onStatus({ ...this.status(), last: { id, state, detail } });
  }

  /**
   * 发送一条信封消息。
   * @param {'all'|string} to 'all' 或某个 peerId
   * @param {object} msg      已经是信封格式的对象
   * @returns {number} 成功交给几条通道
   */
  send(to, msg) {
    if (this.closed) return 0;
    const payload = JSON.stringify(msg);
    let n = 0;
    for (const ch of this.channels) {
      if (!ch.connected) continue;
      try {
        if (ch.publish(to, payload)) n++;
      } catch {
        /* 单条通道失败不影响其它通道 */
      }
    }
    return n;
  }

  /** 接收：去重后交给上层 */
  _receive(channelId, payload) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg || msg.v !== PROTOCOL_VERSION) return;
    if (msg.to !== 'all' && msg.to !== this.peerId) return; // 不是给我们的
    if (msg.from === this.peerId) return; // 自己发的回环
    if (msg.id) {
      if (this.seen.has(msg.id)) return;
      this.seen.add(msg.id);
      this.seenOrder.push(msg.id);
      if (this.seenOrder.length > 600) {
        this.seen.delete(this.seenOrder.shift());
      }
    }
    try {
      this.onMessage(msg.from, msg, channelId);
    } catch (e) {
      console.warn('处理信令消息失败', e);
    }
  }

  close() {
    this.closed = true;
    for (const ch of this.channels) {
      try {
        ch.close();
      } catch {
        /* 忽略 */
      }
    }
    this.channels = [];
  }
}