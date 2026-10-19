/**
 * Shell Gambit — 联网协议与工具
 *
 * 房间号匹配靠「公共信令通道」（见 channels.js），对局数据走 WebRTC DataChannel，
 * DataChannel 建不起来时自动降级为「中转模式」（同样走信令通道）。
 */

/** 消息版本，将来协议变更时用于兼容判断 */
export const PROTOCOL_VERSION = 1;

/** 房间号字母表：去掉了容易看错的 I O 0 1 */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

/** 生成一个房间号，例如 "K7M2Q" */
export function makeRoomCode() {
  let s = '';
  const buf = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(buf);
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    s += ROOM_ALPHABET[buf[i] % ROOM_ALPHABET.length];
  }
  return s;
}

/** 规整用户输入的房间号：大写、去空格、去掉非法字符 */
export function normalizeRoomCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .slice(0, ROOM_CODE_LENGTH);
}

/** 生成一个本机唯一的 peer id */
export function makePeerId() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return buf[0].toString(36) + buf[1].toString(36);
}

/** 生成一条消息 id（用于去重） */
let msgCounter = 0;
export function makeMsgId(peerId) {
  msgCounter += 1;
  return `${peerId}-${Date.now().toString(36)}-${msgCounter}`;
}

/** 消息类型 */
export const MSG = {
  // --- 信令 / 大厅（走公共信令通道）---
  HELLO: 'hello', // 客户端广播：有人吗
  HOST_PRESENT: 'host-present', // 房主广播：我在
  OFFER: 'offer', // 客户端 → 房主
  ANSWER: 'answer', // 房主 → 客户端
  ICE: 'ice', // 双向
  LOBBY: 'lobby', // 房主 → 所有人：房间成员
  START: 'start', // 房主 → 所有人：开局
  REACTION: 'reaction', // 鲜花 / 鸡蛋
  BYE: 'bye', // 离开

  // --- 对局（优先走 DataChannel，失败走中转）---
  ACTION: 'action', // 客户端 → 房主：我要这么做
  ACTION_ACK: 'action-ack', // 房主 → 客户端：已受理 / 被拒绝
  STATE: 'state', // 房主 → 单个客户端：你该看到的状态（已裁剪）
  STATE_ACK: 'state-ack', // 客户端 → 房主：我收到第几帧了
  STATE_REQ: 'state-req', // 客户端 → 房主：我这帧没收到，请立刻补发
  OVER: 'over', // 房主 → 所有人：对局结束
  REMATCH: 'rematch', // 再来一局
  PING: 'ping',
  PONG: 'pong',
};

/**
 * 包一层信封，方便去重与路由。
 *
 * 注意：路由字段（id/from/to/type）一律写在最后，
 * 保证业务字段永远覆盖不掉它们 —— 否则「消息发给谁」会被业务数据悄悄改掉。
 */
export function envelope({ id, from, to, type, ...rest }) {
  return { ...rest, v: PROTOCOL_VERSION, id, from, to, type };
}

/**
 * 单个 peer 的直连状态。
 * 从未连上 → relay（中转）；连上后 → direct（P2P 直连）。
 */
export const LINK = {
  CONNECTING: 'connecting',
  DIRECT: 'direct',
  RELAY: 'relay',
};