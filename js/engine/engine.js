/**
 * Shell Gambit — 权威游戏引擎（纯逻辑，无 DOM、无网络）
 *
 * 设计要点
 *  - 房主端是唯一权威：所有判定都在这里发生，客户端只发“意图”。
 *  - 引擎不认识“真人 / AI”，只认 playerId，因此 AI 与真人规则完全一致。
 *  - 全部随机走 state.rng，给定 seed 可完整复现一局。
 *  - 状态分为「公开信息」与「私有信息」：
 *      公开：血量、存活、手牌张数、座位、手铐、当前弹匣剩余实弹/空弹数量、事件日志
 *      私有：自己的手牌内容、放大镜看到的结果、弹匣真实顺序
 *    viewFor() 负责裁剪，联机时发给客户端的永远是裁剪后的视图。
 *
 * 术语
 *  - 回合 (turn)  = 一名玩家的「发牌 → 行动 → 结束」
 *  - 轮   (round) = 一个弹匣周期：装填 → 打完 → 再装填
 */

import {
  ALL_ITEMS,
  BASE_DAMAGE,
  COPIES_PER_ITEM,
  ITEM_INFO,
  MAX_ACTIONS_PER_TURN,
  MAX_HAND,
  MAX_HP,
  MAX_TOTAL_ACTIONS,
  RECYCLE_THRESHOLD,
  SAW_DAMAGE,
  SHELL_BLANK,
  SHELL_LIVE,
  START_HAND,
  START_HP,
  TOTAL_CARDS,
} from './constants.js';
import { makeRng, randomSeed } from './rng.js';

/** 除自己以外的存活玩家 */
const others = (state, id) => state.players.filter((p) => p.alive && p.id !== id);
/** 按 id 取玩家 */
export const playerById = (state, id) => state.players.find((p) => p.id === id) || null;
/** 存活玩家（按座位号升序） */
const alivePlayers = (state) => state.players.filter((p) => p.alive);

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

/**
 * 事件日志供 UI 播报/动画使用，全部是公开信息。
 * n 单调递增，客户端据此去重与排序。
 */
function pushEvent(state, event) {
  state.seq += 1;
  const entry = { n: state.seq, ...event };
  state.log.push(entry);
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
  return entry;
}

/* ------------------------------------------------------------------ *
 * 创建对局
 * ------------------------------------------------------------------ */

/**
 * 创建一局新游戏。
 *
 * @param {object}   opts
 * @param {{id:string,name:string}[]} opts.players 2–4 名玩家（传入顺序无关，座位随机分配）
 * @param {number}  [opts.seed] 随机种子，便于复现
 * @returns {object} 完整的权威状态
 */
export function createGame({ players, seed = randomSeed() }) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error('createGame: 需要 2–4 名玩家');
  }
  const rng = makeRng(seed);

  // 随机分配座位：1 号座位为每轮的开始
  const seated = rng.shuffle(players.slice());

  const state = {
    seed,
    rng,
    phase: 'playing', // playing | over
    round: 0,
    turn: null,
    turnNo: 0, // 全局第几个回合（用于“第一轮第一回合只摸一张”）
    actionsThisTurn: 0,
    totalActions: 0,
    saw: false, // 手锯是否已上膛
    players: seated.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: i + 1,
      hp: START_HP,
      alive: true,
      hand: [],
      cuffed: false,
    })),
    // 弹匣：shells 是真实顺序，index 是当前枪膛位置。真实顺序只存在于房主内存中。
    magazine: { shells: [], index: 0 },
    load: { live: 0, blank: 0 }, // 本轮装填的实弹/空弹总数（公开）
    drawPile: [], // 摸牌堆：顶部 = 数组头
    discard: [], // 弃牌堆
    knowledge: {}, // 放大镜情报：playerId -> 'live' | 'blank'
    pending: null, // 需要二次选择目标的子状态（肾上腺素偷到手铐等）
    winner: null,
    log: [],
    seq: 0,
  };

  // 初始牌堆：7 种 × 4 张 = 28 张
  const deck = [];
  for (const item of ALL_ITEMS) {
    for (let i = 0; i < COPIES_PER_ITEM; i++) deck.push(item);
  }
  state.drawPile = rng.shuffle(deck);

  // 开局每人 2 张
  for (const p of state.players) {
    for (let i = 0; i < START_HAND; i++) {
      const card = state.drawPile.shift();
      if (card) p.hand.push(card);
    }
  }

  startRound(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * 弹匣 / 装填
 * ------------------------------------------------------------------ */

/**
 * 装填新一轮弹药。
 *
 * 规则（与需求确认一致）：
 *  - 总弹数 = 随机 [人数×2, 人数×3]
 *  - 实弹数 = 随机 [1, 总弹数-1]（保证实弹与空弹都存在，即“混合弹序”）
 *  - 实弹/空弹总数对所有人公开，先后顺序保密
 */
function reloadMagazine(state) {
  const n = state.players.length;
  const total = state.rng.int(n * 2, n * 3);
  const live = state.rng.int(1, total - 1);
  const blank = total - live;

  const shells = [];
  for (let i = 0; i < live; i++) shells.push(SHELL_LIVE);
  for (let i = 0; i < blank; i++) shells.push(SHELL_BLANK);
  state.rng.shuffle(shells);

  state.magazine = { shells, index: 0 };
  state.load = { live, blank };
  state.knowledge = {};
  return state.load;
}

/** 当前枪膛里是否还有子弹 */
const hasShell = (state) => state.magazine.index < state.magazine.shells.length;

/** 当前这一发子弹的真实类型（仅房主内部使用） */
function peekShell(state) {
  if (!hasShell(state)) return null;
  return state.magazine.shells[state.magazine.index];
}

/**
 * 剩余实弹/空弹数量（公开信息）。
 * 直接从真实顺序推导，不额外维护第二份计数，避免数据漂移。
 */
export function remainingCounts(state) {
  let live = 0;
  let blank = 0;
  for (let i = state.magazine.index; i < state.magazine.shells.length; i++) {
    if (state.magazine.shells[i] === SHELL_LIVE) live++;
    else blank++;
  }
  return { live, blank, total: live + blank };
}

/** 开始新的一轮：装弹，并把回合交给最小座号的存活玩家 */
function startRound(state) {
  state.round += 1;
  state.saw = false;
  state.pending = null;
  const load = reloadMagazine(state);
  pushEvent(state, { t: 'round', round: state.round, live: load.live, blank: load.blank });

  // 1 号为每轮的开始；1 号已淘汰则顺延到下一个存活座位。
  // 如果 1 号还戴着手铐（上一轮没轮到他行动就结束/换弹了），一样要跳过。
  const first = alivePlayers(state)[0];
  state.turn = pickNextPlayer(state, first.id, { exclusive: false }) || first.id;
  beginTurn(state);
}

/* ------------------------------------------------------------------ *
 * 发牌
 * ------------------------------------------------------------------ */

/**
 * 摸牌堆不足 4 张时，把整个弃牌堆洗匀后放到摸牌堆「底下」。
 * 顶部 = 数组头，底部 = 数组尾；抽牌永远从顶部取。
 */
function ensureDrawPile(state) {
  if (state.drawPile.length >= RECYCLE_THRESHOLD) return false;
  if (state.discard.length === 0) return false;
  const recycled = state.rng.shuffle(state.discard.slice());
  state.discard.length = 0;
  state.drawPile.push(...recycled); // 放到摸牌堆底下
  pushEvent(state, { t: 'recycle', count: recycled.length });
  return true;
}

/** 从顶部抽一张牌，没有则返回 null */
function drawCard(state) {
  ensureDrawPile(state);
  if (state.drawPile.length === 0) return null;
  return state.drawPile.shift();
}

/**
 * 本回合应发几张牌。
 *  - 发牌前手牌 = 4 → 0 张
 *  - 发牌前手牌 = 3 → 1 张
 *  - 其余          → 2 张
 *  - 全局第一回合  → 最多 1 张
 */
export function drawCountFor(handSize, isFirstTurnOfGame) {
  let n = handSize >= MAX_HAND ? 0 : handSize === MAX_HAND - 1 ? 1 : 2;
  if (isFirstTurnOfGame) n = Math.min(n, 1);
  return n;
}

/** 回合开始：发牌 */
function beginTurn(state) {
  state.turnNo += 1;
  state.actionsThisTurn = 0;
  const p = playerById(state, state.turn);
  if (!p || !p.alive) return;

  const n = drawCountFor(p.hand.length, state.turnNo === 1);
  let drew = 0;
  for (let i = 0; i < n; i++) {
    const card = drawCard(state);
    if (!card) break;
    p.hand.push(card);
    drew++;
  }
  pushEvent(state, { t: 'turn', round: state.round, player: p.id, drew });
}

/* ------------------------------------------------------------------ *
 * 合法动作
 * ------------------------------------------------------------------ */

/** 某个道具可以指定哪些目标 */
function targetsFor(state, me, item) {
  const list = others(state, me.id);
  if (item === 'handcuffs') return list.filter((p) => !p.cuffed);
  return list;
}

/** 手牌里是否真的有这张牌（防作弊 / 防状态漂移） */
const hasItem = (player, item) => player.hand.includes(item);

function canUseItem(state, me, item) {
  if (!hasItem(me, item)) return false;
  switch (item) {
    case 'magnifier':
    case 'inverter':
    case 'beer':
      return hasShell(state);
    case 'handsaw':
      return !state.saw; // 已经锯过就不允许再浪费一张
    case 'adrenaline':
      return others(state, me.id).length > 0;
    case 'handcuffs':
      return targetsFor(state, me, item).length > 0;
    case 'cigarette':
      return true; // 满血使用属于浪费，但规则上允许
    default:
      return false;
  }
}

/**
 * 返回该玩家当前所有合法动作。
 * 客户端据此渲染按钮，房主据此校验请求，两端共用同一份规则。
 *
 * @returns {Array<{type:'use'|'shoot'|'target', item?:string, targetId?:string}>}
 */
export function legalActions(state, playerId) {
  if (state.phase !== 'playing') return [];
  if (state.turn !== playerId) return [];

  // 需要二次选择目标（肾上腺素偷到手铐）
  if (state.pending) {
    if (state.pending.actorId !== playerId) return [];
    const list = others(state, playerId);
    const pool = state.pending.item === 'handcuffs' ? list.filter((p) => !p.cuffed) : list;
    return pool.map((p) => ({ type: 'target', targetId: p.id }));
  }

  const me = playerById(state, playerId);
  if (!me || !me.alive) return [];

  const actions = [];
  for (const item of [...new Set(me.hand)]) {
    if (!canUseItem(state, me, item)) continue;
    if (ITEM_INFO[item].needsTarget) {
      for (const t of targetsFor(state, me, item)) {
        actions.push({ type: 'use', item, targetId: t.id });
      }
    } else {
      actions.push({ type: 'use', item });
    }
  }
  // 开枪：可以打自己，也可以打任意存活对手
  if (hasShell(state)) {
    actions.push({ type: 'shoot', targetId: me.id });
    for (const t of others(state, playerId)) actions.push({ type: 'shoot', targetId: t.id });
  }
  return actions;
}

/* ------------------------------------------------------------------ *
 * 执行动作
 * ------------------------------------------------------------------ */

/** 消费一张手牌 → 弃牌堆 */
function consumeCard(state, player, item) {
  const i = player.hand.indexOf(item);
  if (i >= 0) player.hand.splice(i, 1);
  state.discard.push(item);
}

/**
 * 执行一个动作。
 * 非法动作不会产生任何副作用（先校验、后修改）。
 *
 * @returns {{ok:true, events:object[]} | {ok:false, error:string}}
 */
export function applyAction(state, playerId, action) {
  if (state.phase !== 'playing') return { ok: false, error: '对局已结束' };
  if (!action || typeof action !== 'object') return { ok: false, error: '非法动作' };
  if (state.totalActions >= MAX_TOTAL_ACTIONS) return { ok: false, error: '对局动作数超限' };
  if (state.actionsThisTurn >= MAX_ACTIONS_PER_TURN) return { ok: false, error: '单回合动作数超限' };

  const legal = legalActions(state, playerId);
  const ok = legal.some(
    (a) =>
      a.type === action.type &&
      a.item === action.item &&
      (a.targetId || null) === (action.targetId || null)
  );
  if (!ok) return { ok: false, error: '非法动作' };

  const sinceSeq = state.seq;
  state.totalActions += 1;
  state.actionsThisTurn += 1;

  if (action.type === 'target') {
    resolvePendingTarget(state, playerId, action.targetId);
  } else if (action.type === 'use') {
    useItem(state, playerId, action.item, action.targetId);
  } else {
    shoot(state, playerId, action.targetId);
  }

  // 用 seq 切分本次动作产生的事件（日志会被裁剪，不能用下标）
  return { ok: true, events: state.log.filter((e) => e.n > sinceSeq) };
}

/* ---------------------- 道具效果 ---------------------- */

function useItem(state, actorId, item, targetId) {
  const me = playerById(state, actorId);
  if (!me || !me.alive) return;

  switch (item) {
    case 'magnifier': {
      // 只有使用者本人能看到结果
      state.knowledge[actorId] = peekShell(state);
      consumeCard(state, me, item);
      pushEvent(state, { t: 'use', player: actorId, item });
      break;
    }

    case 'inverter': {
      invertCurrentShell(state);
      consumeCard(state, me, item);
      pushEvent(state, { t: 'use', player: actorId, item });
      break;
    }

    case 'beer': {
      // 退出当前这一发，子弹类型公开给所有人
      const shell = peekShell(state);
      state.magazine.index += 1;
      state.knowledge = {}; // 换了一发，旧情报作废
      consumeCard(state, me, item);
      pushEvent(state, { t: 'use', player: actorId, item, ejected: shell });
      afterShellConsumed(state);
      break;
    }

    case 'handsaw': {
      state.saw = true;
      consumeCard(state, me, item);
      pushEvent(state, { t: 'use', player: actorId, item });
      break;
    }

    case 'cigarette': {
      const before = me.hp;
      me.hp = Math.min(MAX_HP, me.hp + 1);
      consumeCard(state, me, item);
      pushEvent(state, { t: 'use', player: actorId, item, healed: me.hp - before });
      break;
    }

    case 'handcuffs': {
      const target = playerById(state, targetId);
      if (!target || !target.alive || target.cuffed) break;
      target.cuffed = true;
      consumeCard(state, me, item);
      pushEvent(state, { t: 'use', player: actorId, item, target: targetId });
      break;
    }

    case 'adrenaline': {
      const target = playerById(state, targetId);
      if (!target || !target.alive) break;
      consumeCard(state, me, item);
      // 肾上腺素本身不可被偷，避免无限递归
      const stealable = target.hand.filter((c) => c !== 'adrenaline');
      if (stealable.length === 0) {
        pushEvent(state, { t: 'use', player: actorId, item, target: targetId, stolen: null });
        break;
      }
      const stolen = state.rng.pick(stealable);
      target.hand.splice(target.hand.indexOf(stolen), 1);
      // 需要指定目标的道具（手铐）：必须存在合法目标才挂起，
      // 否则会出现「无人可铐」的死锁（例：2 人局里对手已被自己铐住）。
      const needsTarget = ITEM_INFO[stolen].needsTarget;
      const targets = needsTarget ? targetsFor(state, me, stolen) : [];
      if (needsTarget && targets.length === 0) {
        state.discard.push(stolen); // 没有合法目标 → 这张牌直接作废
        pushEvent(state, { t: 'use', player: actorId, item, target: targetId, stolen, wasted: true });
        break;
      }
      if (needsTarget) {
        // 需要指定目标：挂起，等待使用者二次选择。
        // 这张牌此刻“在手上飞行”，既不在某人手中也不在弃牌堆，
        // checkInvariants 会把它计入 pending 以保证 28 张守恒。
        state.pending = { kind: 'stolen-target', actorId, item: stolen, from: targetId };
        pushEvent(state, { t: 'use', player: actorId, item, target: targetId, stolen, awaitingTarget: true });
      } else {
        pushEvent(state, { t: 'use', player: actorId, item, target: targetId, stolen });
        applyStolenEffect(state, me, stolen);
      }
      break;
    }

    default:
      break;
  }
}

/** 反转当前这一发子弹。逆转是公开信息：原本知道的人可以顺推出新值。 */
function invertCurrentShell(state) {
  const i = state.magazine.index;
  if (i >= state.magazine.shells.length) return;
  const was = state.magazine.shells[i];
  state.magazine.shells[i] = was === SHELL_LIVE ? SHELL_BLANK : SHELL_LIVE;
  for (const pid of Object.keys(state.knowledge)) {
    state.knowledge[pid] = state.knowledge[pid] === SHELL_LIVE ? SHELL_BLANK : SHELL_LIVE;
  }
}

/** 使用偷来的、不需要指定目标的道具 */
function applyStolenEffect(state, me, item) {
  switch (item) {
    case 'magnifier':
      state.knowledge[me.id] = peekShell(state);
      state.discard.push(item);
      break;
    case 'inverter':
      invertCurrentShell(state);
      state.discard.push(item);
      break;
    case 'beer': {
      const shell = peekShell(state);
      state.magazine.index += 1;
      state.knowledge = {};
      state.discard.push(item);
      pushEvent(state, { t: 'use', player: me.id, item, ejected: shell, viaStolen: true });
      afterShellConsumed(state);
      break;
    }
    case 'handsaw':
      state.saw = true;
      state.discard.push(item);
      pushEvent(state, { t: 'use', player: me.id, item, viaStolen: true });
      break;
    case 'cigarette': {
      const before = me.hp;
      me.hp = Math.min(MAX_HP, me.hp + 1);
      state.discard.push(item);
      pushEvent(state, { t: 'use', player: me.id, item, healed: me.hp - before, viaStolen: true });
      break;
    }
    default:
      state.discard.push(item);
      break;
  }
}

/** 肾上腺素偷到手铐后，使用者指定目标 */
function resolvePendingTarget(state, actorId, targetId) {
  const pending = state.pending;
  if (!pending || pending.actorId !== actorId) return;
  const target = playerById(state, targetId);
  if (!target || !target.alive) return;
  state.pending = null;
  if (pending.item === 'handcuffs' && !target.cuffed) {
    target.cuffed = true;
    pushEvent(state, { t: 'use', player: actorId, item: 'handcuffs', target: targetId, viaStolen: true });
  }
  state.discard.push(pending.item);
}

/* ---------------------- 开枪 ---------------------- */

function shoot(state, actorId, targetId) {
  const shooter = playerById(state, actorId);
  const target = playerById(state, targetId);
  if (!shooter || !target) return;

  const shell = peekShell(state);
  if (shell === null) {
    // 防御：弹匣为空却要求开枪（正常流程不会出现），直接交棒避免死锁
    endTurn(state);
    return;
  }

  const wasSaw = state.saw;
  state.magazine.index += 1;
  state.saw = false; // 手锯只对下一发有效，打出空弹也算浪费
  state.knowledge = {}; // 换了一发，旧情报作废

  const selfShot = actorId === targetId;

  if (shell === SHELL_LIVE) {
    const dmg = wasSaw ? SAW_DAMAGE : BASE_DAMAGE;
    target.hp = Math.max(0, target.hp - dmg);
    const lethal = target.hp === 0;
    if (lethal) {
      target.alive = false;
      // 淘汰者的手牌全部进入弃牌堆
      state.discard.push(...target.hand);
      target.hand.length = 0;
      target.cuffed = false;
      delete state.knowledge[target.id];
    }
    pushEvent(state, {
      t: 'shoot',
      player: actorId,
      target: targetId,
      self: selfShot,
      shell,
      damage: dmg,
      saw: wasSaw,
      lethal,
    });
    if (lethal) pushEvent(state, { t: 'elim', player: targetId });

    const survivors = alivePlayers(state);
    if (survivors.length <= 1) {
      state.phase = 'over';
      state.winner = survivors.length === 1 ? survivors[0].id : null;
      state.pending = null;
      pushEvent(state, { t: 'over', winner: state.winner });
      return;
    }
  } else {
    pushEvent(state, {
      t: 'shoot',
      player: actorId,
      target: targetId,
      self: selfShot,
      shell,
      damage: 0,
      saw: wasSaw,
      lethal: false,
    });
  }

  // 打完这一发后弹匣可能空了 —— 空则立刻进入下一轮，回合交给新一轮先手
  if (afterShellConsumed(state)) return;
  if (state.phase !== 'playing') return;
  // 空弹打自己：不扣血、保留回合，可以继续操作
  if (shell === SHELL_BLANK && selfShot) return;
  endTurn(state);
}

/**
 * 每消费掉一发子弹后调用：弹匣打空则自动换弹开始新一轮。
 * @returns {boolean} 是否触发了换弹（换弹后回合归属已由 startRound 决定）
 */
function afterShellConsumed(state) {
  if (state.phase !== 'playing') return false;
  if (hasShell(state)) return false;
  if (alivePlayers(state).length <= 1) return false;
  startRound(state);
  return true;
}

/**
 * 选出「下一个真正能行动的人」，顺手把被跳过者的手铐用掉。
 *
 * 手铐在「这一回合被跳过」的那一刻就消耗掉了，所以这里只要判定 cuffed 就跳过并解除。
 *
 * @param {string} fromId  从谁开始往后找
 * @param {{exclusive?: boolean}} opts
 *   exclusive=true（回合交接）：只在 fromId **以外**的人里找；
 *   exclusive=false（每轮开始）：从 fromId 本人开始找。
 *
 * 为什么要单独写这个函数：回合交接时如果「其他人都被锁住」，
 * 回合必须回到 fromId 本人身上 —— 不能顺延给「下一个人」。
 * 那个人刚刚已经被跳过、手铐也解除过了，再让他行动等于白送一个回合，
 * 这正是「品被手铐跳过之后照样摸牌出牌开枪」的根因。
 */
function pickNextPlayer(state, fromId, { exclusive = true } = {}) {
  const alive = alivePlayers(state);
  if (alive.length <= 1) return alive[0]?.id ?? null;
  const startIdx = Math.max(0, alive.findIndex((p) => p.id === fromId));

  // 候选顺序：只绕一圈
  const candidates = [];
  for (let k = exclusive ? 1 : 0; k <= alive.length - 1; k++) {
    candidates.push(alive[(startIdx + k) % alive.length]);
  }

  const free = candidates.find((p) => !p.cuffed);
  if (free) {
    // free 之前的人全被跳过（手铐在这里消耗掉）
    for (const p of candidates) {
      if (p === free) break;
      p.cuffed = false;
      pushEvent(state, { t: 'skip', player: p.id });
    }
    return free.id;
  }

  // 候选里全员戴着手铐：手铐只能作废，否则整局直接死锁
  for (const p of alive) p.cuffed = false;
  if (exclusive) {
    // 回合交接：其他人都丢掉了这一回合，那么继续由 fromId 行动
    for (const p of candidates) pushEvent(state, { t: 'skip', player: p.id });
    return alive[startIdx].id;
  }
  // 每轮开始：全员被锁，解除后由第一位行动（不发 skip，免得「跳过了又马上行动」自相矛盾）
  return candidates[0].id;
}

/** 结束当前回合，把回合交给下一位能行动的存活玩家 */
function endTurn(state) {
  if (state.phase !== 'playing') return;
  state.pending = null;
  const alive = alivePlayers(state);
  if (alive.length <= 1) return;

  const next = pickNextPlayer(state, state.turn, { exclusive: true });
  if (!next) return;
  state.turn = next;
  beginTurn(state);
}

/* ------------------------------------------------------------------ *
 * 视图裁剪（联机时发给客户端的唯一数据）
 * ------------------------------------------------------------------ */

/**
 * 为指定玩家生成私有视图。
 * 关键：绝不包含弹匣真实顺序、他人手牌内容、他人的放大镜情报。
 */
export function viewFor(state, playerId) {
  const counts = remainingCounts(state);
  const me = playerById(state, playerId);

  let pending = null;
  if (state.pending) {
    pending =
      state.pending.actorId === playerId
        ? { kind: state.pending.kind, item: state.pending.item, from: state.pending.from }
        : { kind: state.pending.kind, waitingFor: state.pending.actorId };
  }

  return {
    seq: state.seq,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    turnNo: state.turnNo,
    winner: state.winner,
    saw: state.saw,
    magazine: counts, // 只有数量，没有顺序
    load: { ...state.load },
    drawPileCount: state.drawPile.length,
    discardCount: state.discard.length,
    players: state.players
      .map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        hp: p.hp,
        alive: p.alive,
        handCount: p.hand.length,
        cuffed: p.cuffed,
      }))
      .sort((a, b) => a.seat - b.seat),
    me: me
      ? {
          id: me.id,
          seat: me.seat,
          hp: me.hp,
          alive: me.alive,
          hand: me.hand.slice(),
          knows: state.knowledge[me.id] || null,
          legal: legalActions(state, playerId),
        }
      : null,
    pending,
    log: state.log.slice(-40),
  };
}

/* ------------------------------------------------------------------ *
 * 调试 / 测试辅助
 * ------------------------------------------------------------------ */

/** 深拷贝权威状态（保留 rng 引用）。用于测试中“先试后回滚”。 */
export function cloneState(state) {
  const copy = { ...state, rng: state.rng };
  copy.players = state.players.map((p) => ({ ...p, hand: p.hand.slice() }));
  copy.magazine = { shells: state.magazine.shells.slice(), index: state.magazine.index };
  copy.load = { ...state.load };
  copy.drawPile = state.drawPile.slice();
  copy.discard = state.discard.slice();
  copy.knowledge = { ...state.knowledge };
  copy.pending = state.pending ? { ...state.pending } : null;
  copy.log = state.log.slice();
  return copy;
}

/**
 * 校验状态不变量。任何一条被打破都说明引擎有 BUG。
 * 自对弈测试在每一步之后都会调用它。
 *
 * @returns {string[]} 被违反的不变量描述（空数组 = 健康）
 */
export function checkInvariants(state) {
  const bad = [];
  // 28 张牌守恒：手牌 + 摸牌堆 + 弃牌堆 + “飞行中”（肾上腺素待指定目标时的那张）
  const inHands = state.players.reduce((s, p) => s + p.hand.length, 0);
  const inFlight = state.pending && state.pending.kind === 'stolen-target' ? 1 : 0;
  const total = inHands + state.drawPile.length + state.discard.length + inFlight;
  if (total !== TOTAL_CARDS) bad.push(`道具总数应为 ${TOTAL_CARDS}，实际 ${total}`);

  for (const p of state.players) {
    if (p.hp < 0 || p.hp > MAX_HP) bad.push(`${p.id} 血量越界: ${p.hp}`);
    if (p.hand.length > MAX_HAND) bad.push(`${p.id} 手牌超上限: ${p.hand.length}`);
    if (!p.alive && p.hand.length > 0) bad.push(`${p.id} 已淘汰却还有手牌`);
    if (!p.alive && p.hp !== 0) bad.push(`${p.id} 已淘汰但血量不为 0: ${p.hp}`);
    for (const c of p.hand) {
      if (!ALL_ITEMS.includes(c)) bad.push(`${p.id} 手里有未知道具: ${c}`);
    }
  }
  for (const c of [...state.drawPile, ...state.discard]) {
    if (!ALL_ITEMS.includes(c)) bad.push(`牌堆里有未知道具: ${c}`);
  }

  if (state.phase === 'playing') {
    if (alivePlayers(state).length < 2) bad.push('仍在进行中但存活玩家少于 2');
    const t = playerById(state, state.turn);
    if (!t) bad.push(`回合指向不存在的玩家: ${state.turn}`);
    else if (!t.alive) bad.push(`回合指向已淘汰玩家: ${state.turn}`);
    // 被手铐锁住的人必须被跳过；回合落在他身上说明跳过逻辑漏了
    else if (t.cuffed) bad.push(`回合指向被手铐锁住的玩家（该跳过却没跳过）: ${state.turn}`);
    if (!hasShell(state)) bad.push('对局进行中但弹匣为空');
    if (state.pending && state.pending.actorId !== state.turn) {
      bad.push('挂起目标选择，但回合不属于该玩家');
    }
    // 最关键的一条：当前玩家必须永远有棋可走，否则就是死锁
    if (t?.alive && legalActions(state, state.turn).length === 0) {
      bad.push(`${state.turn} 当前没有任何合法动作（死锁）`);
    }
  }
  if (state.phase === 'over') {
    if (alivePlayers(state).length > 1) bad.push('对局已结束但存活玩家多于 1');
    const w = state.winner ? playerById(state, state.winner) : null;
    if (state.winner && !w?.alive) bad.push('胜者已淘汰');
  }
  return bad;
}