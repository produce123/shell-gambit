/**
 * Shell Gambit — WebRTC 星型 P2P
 *
 * 拓扑：房主是中心，每个客户端只与房主建一条 DataChannel。
 *   · 2–4 人局完全够用，比全网状少建一大半连接
 *   · 房主是权威，所有对局数据天然需要汇聚到房主，星型正好匹配
 *
 * 降级策略：DataChannel 建不起来（对称 NAT / 防火墙 / 同局域网握手失败等）时，
 * 这条链路自动标记为 relay，改走公共信令通道中转，对局照样能进行。
 */

import { LINK, MSG } from './protocol.js';

/** 公共 STUN。没有可用 TURN，兜底交给「中转模式」。 */
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.nextcloud.com:443'] },
  ],
  iceCandidatePoolSize: 2,
  bundlePolicy: 'max-bundle',
};

/** 多久还没连上就重启一次 ICE */
const RETRY_AFTER_MS = 6000;
/** 多久还没连上就放弃直连、转中转 */
const GIVE_UP_AFTER_MS = 14000;

/**
 * 与单个 peer 的链路。
 */
export class PeerLink {
  /**
   * @param {object} opts
   * @param {string} opts.selfId
   * @param {string} opts.peerId
   * @param {boolean} opts.isHost      房主侧只应答，客户端侧主动发 offer
   * @param {(to:string, msg:object)=>void} opts.signalOut 发信令（走信令通道）
   * @param {(to:string, msg:object)=>void} opts.relayOut  中转发对局消息（走信令通道）
   * @param {(from:string, msg:object)=>void} opts.onMessage
   * @param {(peerId:string, mode:string)=>void} [opts.onModeChange]
   */
  constructor({ selfId, peerId, isHost, signalOut, relayOut, onMessage, onModeChange }) {
    this.selfId = selfId;
    this.peerId = peerId;
    this.isHost = isHost;
    this.signalOut = signalOut;
    this.relayOut = relayOut;
    this.onMessage = onMessage;
    this.onModeChange = onModeChange || (() => {});

    this.pc = null;
    this.dc = null;
    this.mode = LINK.CONNECTING;
    this.pendingIce = [];
    this.remoteSet = false;
    this.closed = false;
    this.retryTimer = null;
    this.giveUpTimer = null;
    this.reported = false;
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onModeChange(this.peerId, mode);
  }

  _signal(type, extra) {
    this.signalOut(this.peerId, { type, from: this.selfId, ...extra });
  }

  _wirePc() {
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._signal(MSG.ICE, { candidate: ev.candidate.toJSON() });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed' || st === 'closed') {
        this._setMode(LINK.RELAY);
      } else if (st === 'disconnected') {
        // 可能只是短暂抖动，超时后仍未恢复则转中转
        setTimeout(() => {
          if (!this.closed && this.pc && this.pc.connectionState === 'disconnected') {
            this._setMode(LINK.RELAY);
          }
        }, 4000);
      }
    };
  }

  _wireDc(dc) {
    this.dc = dc;
    dc.onopen = () => {
      this._setMode(LINK.DIRECT);
      clearTimeout(this.retryTimer);
      clearTimeout(this.giveUpTimer);
    };
    dc.onclose = () => this._setMode(LINK.RELAY);
    dc.onerror = () => this._setMode(LINK.RELAY);
    dc.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(this.peerId, msg, LINK.DIRECT);
    };
  }

  _startTimers() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.giveUpTimer);
    this.retryTimer = setTimeout(() => {
      if (this.closed || this.dc?.readyState === 'open') return;
      // 重启 ICE 再试一次，仍然连不上就让上层走中转
      try {
        this.pc?.restartIce();
      } catch {
        /* 忽略 */
      }
    }, RETRY_AFTER_MS);
    this.giveUpTimer = setTimeout(() => {
      if (this.closed || this.dc?.readyState === 'open') return;
      this._setMode(LINK.RELAY);
    }, GIVE_UP_AFTER_MS);
  }

  /** 客户端侧：创建连接并发出 offer */
  async startAsOfferer() {
    if (this.pc || this.closed) return;
    try {
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this._wirePc();
      this._wireDc(this.pc.createDataChannel('sg', { ordered: true }));
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (this.closed) return;
      this._signal(MSG.OFFER, { sdp: this.pc.localDescription.sdp });
      this._startTimers();
    } catch {
      // 浏览器不支持 WebRTC 之类的情况：直接走中转，对局照样能打
      this._setMode(LINK.RELAY);
    }
  }

  /** 房主侧：收到 offer，回 answer */
  async handleOffer(sdp) {
    if (this.closed) return;
    try {
      if (!this.pc) {
        this.pc = new RTCPeerConnection(RTC_CONFIG);
        this._wirePc();
        this.pc.ondatachannel = (ev) => this._wireDc(ev.channel);
        this._startTimers();
      }
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      this.remoteSet = true;
      await this._flushIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      if (this.closed) return;
      this._signal(MSG.ANSWER, { sdp: this.pc.localDescription.sdp });
    } catch {
      this._setMode(LINK.RELAY);
    }
  }

  /** 客户端侧：收到 answer */
  async handleAnswer(sdp) {
    if (this.closed || !this.pc) return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteSet = true;
      await this._flushIce();
    } catch (e) {
      this._setMode(LINK.RELAY);
    }
  }

  /** 收到 ICE 候选。远端描述还没设置好时先缓存。 */
  async handleIce(candidate) {
    if (this.closed || !candidate) return;
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      /* 个别候选失败不影响整体，忽略 */
    }
  }

  async _flushIce() {
    const list = this.pendingIce;
    this.pendingIce = [];
    for (const c of list) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 直连是否可用 */
  get isDirect() {
    return this.dc?.readyState === 'open';
  }

  /**
   * 发送一条对局消息：直连通就用直连，否则走中转。
   * @returns {'direct'|'relay'} 实际使用的通道
   */
  send(msg) {
    if (this.isDirect) {
      try {
        this.dc.send(JSON.stringify(msg));
        return LINK.DIRECT;
      } catch {
        this._setMode(LINK.RELAY);
      }
    }
    this.relayOut(this.peerId, msg);
    return LINK.RELAY;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.giveUpTimer);
    try {
      this.dc?.close();
    } catch {
      /* 忽略 */
    }
    try {
      this.pc?.close();
    } catch {
      /* 忽略 */
    }
    this.dc = null;
    this.pc = null;
  }
}