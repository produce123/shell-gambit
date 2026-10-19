/**
 * Shell Gambit — 极简 MQTT 3.1.1 over WebSocket 客户端
 *
 * 只实现我们真正需要的部分：CONNECT / SUBSCRIBE(QoS0) / PUBLISH(QoS0) / PINGREQ。
 * 这样就不必引入 mqtt.js 之类的第三方库，整个项目保持零依赖。
 *
 * 为什么必须带自动重连：
 *   公共 broker（尤其是免费公共 broker）会时不时断开连接。
 *   断了就静默重连、重连成功后自动重订阅，对上层完全透明。
 *
 * 注意：这里刻意只做 QoS 0（最多一次）。可靠性由上层保证
 * （动作带 id 重发、状态带 seq 幂等覆盖），见 session.js。
 */

/* ------------------------- 编解码 ------------------------- */

/** 变长「剩余长度」编码 */
function encodeLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

/** MQTT 的 UTF-8 字符串：2 字节长度 + 内容 */
function encodeString(s) {
  const bytes = new TextEncoder().encode(s);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function buildPacket(type, flags, body) {
  return new Uint8Array([(type << 4) | flags, ...encodeLength(body.length), ...body]);
}

/**
 * 从缓冲区里切出完整的 MQTT 报文。
 * WebSocket 的每一帧不保证正好是一个报文，所以必须自己累积、自己切分。
 */
function parsePackets(buf) {
  const packets = [];
  let i = 0;
  while (i < buf.length) {
    const type = buf[i] >> 4;
    let multiplier = 1;
    let length = 0;
    let j = i + 1;
    let b;
    do {
      if (j >= buf.length) return { packets, rest: buf.slice(i) };
      b = buf[j++];
      length += (b & 0x7f) * multiplier;
      multiplier *= 128;
      if (multiplier > 128 * 128 * 128) return { packets, rest: new Uint8Array(0) };
    } while (b & 0x80);
    if (j + length > buf.length) return { packets, rest: buf.slice(i) };
    packets.push({ type, body: buf.slice(j, j + length) });
    i = j + length;
  }
  return { packets, rest: new Uint8Array(0) };
}

function readPublish(body) {
  const topicLen = (body[0] << 8) | body[1];
  const topic = new TextDecoder().decode(body.slice(2, 2 + topicLen));
  const payload = new TextDecoder().decode(body.slice(2 + topicLen));
  return { topic, payload };
}

/* ------------------------- 客户端 ------------------------- */

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 12000;

export class MqttClient {
  /**
   * @param {string} url 例如 wss://broker.hivemq.com:8884/mqtt
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {(topic:string, payload:string)=>void} opts.onMessage
   * @param {(state:'open'|'closed'|'error', detail?:string)=>void} [opts.onStatus]
   */
  constructor(url, { clientId, onMessage, onStatus }) {
    this.url = url;
    this.clientId = clientId;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.buffer = new Uint8Array(0);
    this.packetId = 1;
    this.connected = false;
    this.closedByUs = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    /** 记住订阅，重连后自动恢复 */
    this.subs = [];
    this.pendingSubs = 0;
  }

  /** 第一次连接（不自动重试），成功返回 true */
  connect(timeoutMs = 7000) {
    return this._attempt(timeoutMs);
  }

  _attempt(timeoutMs) {
    return new Promise((resolve) => {
      if (this.closedByUs) return resolve(false);
      if (this.connected) return resolve(true);
      let settled = false;
      let subDeadline = null;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(subDeadline);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        // 超时也要把半死的 socket 关掉，否则会一直挂着
        try {
          this.ws?.close();
        } catch {
          /* 忽略 */
        }
        done(false);
      }, timeoutMs);

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this.onStatus('error', `无法创建连接: ${e.message}`);
        return done(false);
      }
      this.ws = ws;
      this.buffer = new Uint8Array(0);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        // CONNECT：协议名 "MQTT"、版本 4、clean session、keepalive 60s
        try {
          ws.send(buildPacket(1, 0, [...encodeString('MQTT'), 4, 0x02, 0, 60, ...encodeString(this.clientId)]));
        } catch {
          done(false);
        }
      };
      ws.onerror = () => {
        this.onStatus('error', '连接出错');
        done(false);
      };
      ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopPing();
        if (!this.closedByUs) {
          this.onStatus('closed');
          this._scheduleReconnect();
        }
        if (!wasConnected) done(false);
      };
      ws.onmessage = (ev) => {
        const chunk = new Uint8Array(ev.data);
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer);
        merged.set(chunk, this.buffer.length);
        const { packets, rest } = parsePackets(merged);
        this.buffer = rest;

        for (const p of packets) {
          if (p.type === 2) {
            // CONNACK：连上了，但「连上」不等于「订阅已生效」——
            // 必须等 SUBACK，否则这中间别人发来的消息会被 broker 丢掉，
            // 表现就是开局第一个动作石沉大海。
            this.connected = true;
            this.reconnectDelay = RECONNECT_BASE_MS;
            this.startPing();
            this.pendingSubs = 0;
            for (const t of this.subs) {
              this._sendSubscribe(t);
              this.pendingSubs += 1;
            }
            if (this.pendingSubs === 0) {
              this.onStatus('open');
              done(true);
            } else {
              // 兜底：个别公共 broker 不回 SUBACK，等 1.5s 也当它可用
              subDeadline = setTimeout(() => {
                this.onStatus('open');
                done(true);
              }, 1500);
            }
          } else if (p.type === 9) {
            // SUBACK：订阅真的生效了
            if (this.pendingSubs > 0) {
              this.pendingSubs -= 1;
              if (this.pendingSubs === 0) {
                this.onStatus('open');
                done(true);
              }
            }
          } else if (p.type === 3) {
            const { topic, payload } = readPublish(p.body);
            this.onMessage(topic, payload);
          }
          // PINGRESP(13) 无需处理
        }
      };
    });
  }

  _scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByUs || this.connected) return;
      const ok = await this._attempt(8000);
      if (!ok && !this.closedByUs && !this.reconnectTimer) this._scheduleReconnect();
    }, delay);
  }

  startPing() {
    this.stopPing();
    // keepalive 设为 60s，这里 25s 发一次心跳，足够安全
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      try {
        this.ws.send(buildPacket(12, 0, []));
      } catch {
        /* 断线由 onclose 处理 */
      }
    }, 25000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** 订阅一个主题过滤器（QoS 0）。会记住，重连后自动恢复。 */
  subscribe(topicFilter) {
    if (!this.subs.includes(topicFilter)) this.subs.push(topicFilter);
    return this._sendSubscribe(topicFilter);
  }

  _sendSubscribe(topicFilter) {
    if (!this.connected) return false;
    this.packetId += 1;
    const pid = this.packetId & 0xffff;
    try {
      this.ws.send(buildPacket(8, 2, [pid >> 8, pid & 0xff, ...encodeString(topicFilter), 0]));
      return true;
    } catch {
      return false;
    }
  }

  /** 发布一条消息（QoS 0） */
  publish(topic, payload) {
    if (!this.connected) return false;
    const body = [...encodeString(topic), ...new TextEncoder().encode(payload)];
    try {
      this.ws.send(buildPacket(3, 0, body));
      return true;
    } catch {
      return false;
    }
  }

  /** 主动断开（不再重连） */
  close() {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    try {
      if (this.connected) this.ws.send(buildPacket(14, 0, []));
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.connected = false;
  }
}

/**
 * 公共 MQTT 中转（全部 wss + 免鉴权），按可用性排序。
 *
 * 不同网络环境可达性差别很大，所以做成「波浪式」尝试：
 * 一次只并发尝试很少的几条，够用就停 —— 因为公共 broker 普遍限制
 * 同一 IP 的并发连接数，一次开一大堆反而会被踢。
 */
export const MQTT_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://mqtt-dashboard.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
];