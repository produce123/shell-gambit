/**
 * 规则单元测试：覆盖 7 种道具的全部效果与边界。
 * 运行： node tests/rules.test.mjs
 */

import {
  ALL_ITEMS,
  COPIES_PER_ITEM,
  MAX_HP,
  TOTAL_CARDS,
} from '../js/engine/constants.js';
import {
  applyAction,
  checkInvariants,
  createGame,
  drawCountFor,
  legalActions,
  remainingCounts,
  viewFor,
} from '../js/engine/engine.js';
import { assert, eq, run, test } from './harness.mjs';

/* ------------------------- 测试辅助 ------------------------- */

const mk = (n, seed = 12345) =>
  createGame({
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `玩${i + 1}` })),
    seed,
  });

const byId = (s, id) => s.players.find((p) => p.id === id);
const bySeat = (s, seat) => s.players.find((p) => p.seat === seat);

/**
 * 把某个玩家的手牌换成指定内容。
 * 会从「摸牌堆 → 弃牌堆 → 其他玩家手中」依次找牌，保证 28 张牌始终守恒。
 */
function setHand(state, pid, items) {
  const p = byId(state, pid);
  state.discard.push(...p.hand);
  p.hand = [];
  for (const it of items) {
    let i = state.drawPile.indexOf(it);
    if (i >= 0) {
      state.drawPile.splice(i, 1);
      p.hand.push(it);
      continue;
    }
    i = state.discard.indexOf(it);
    if (i >= 0) {
      state.discard.splice(i, 1);
      p.hand.push(it);
      continue;
    }
    // 最后从其他玩家手里拿
    let found = false;
    for (const other of state.players) {
      if (other.id === pid) continue;
      const j = other.hand.indexOf(it);
      if (j >= 0) {
        other.hand.splice(j, 1);
        p.hand.push(it);
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`测试准备失败：整副牌里找不到 ${it}`);
  }
}

/** 直接指定弹匣，用于精确验证每一条分支 */
function setMagazine(state, shells) {
  state.magazine = { shells: [...shells], index: 0 };
  state.load = {
    live: shells.filter((s) => s === 'live').length,
    blank: shells.filter((s) => s === 'blank').length,
  };
  state.knowledge = {};
}

/** 把回合交给指定玩家（不发牌，便于精确断言） */
function setTurn(state, pid) {
  state.turn = pid;
  state.actionsThisTurn = 0;
  state.pending = null;
}

/** 执行一个动作并断言成功 */
function act(state, pid, action) {
  const res = applyAction(state, pid, action);
  assert(res.ok, `动作应合法 ${JSON.stringify(action)}，却返回: ${res.error}`);
  return res.events;
}

/* ------------------------- 建局 ------------------------- */

test('建局：2–4 人、5 血、开局 2 张牌、牌堆共 28 张', () => {
  for (const n of [2, 3, 4]) {
    const s = mk(n);
    eq(s.players.length, n, '人数');
    for (const p of s.players) {
      eq(p.hp, 5, `${p.id} 开局血量`);
      eq(p.alive, true, `${p.id} 存活`);
    }
    // 座位 1 同时是全局第一回合，会补 1 张 → 3 张；其他人保持 2 张
    eq(bySeat(s, 1).hand.length, 3, '座位 1 首回合只补 1 张');
    for (let seat = 2; seat <= n; seat++) {
      eq(bySeat(s, seat).hand.length, 2, `座位 ${seat} 开局 2 张`);
    }
    eq(checkInvariants(s), [], '建局后不变量');
  }
});

test('建局：座位号是 1..n 且不重复', () => {
  for (const n of [2, 3, 4]) {
    const s = mk(n, 999 + n);
    const seats = s.players.map((p) => p.seat).sort();
    eq(seats, Array.from({ length: n }, (_, i) => i + 1), '座位号');
  }
});

test('建局：本轮实弹/空弹数量公开且与弹匣一致', () => {
  const s = mk(4, 777);
  const n = s.players.length;
  const counts = remainingCounts(s);
  eq(counts.total, s.load.live + s.load.blank, '剩余总数 = 本轮装填数');
  const total = s.load.live + s.load.blank;
  assert(total >= n * 2 && total <= n * 3, `总弹数应在 [${n * 2}, ${n * 3}]，实际 ${total}`);
  assert(s.load.live >= 1, '至少 1 发实弹');
  assert(s.load.blank >= 1, '至少 1 发空弹（混合弹序）');
});

/* ------------------------- 发牌规则 ------------------------- */

test('发牌张数：手牌 3 → 1 张，手牌 4 → 0 张，首回合最多 1 张', () => {
  eq(drawCountFor(2, false), 2, '2 张 → 发 2');
  eq(drawCountFor(3, false), 1, '3 张 → 发 1');
  eq(drawCountFor(4, false), 0, '4 张 → 不发');
  eq(drawCountFor(2, true), 1, '首回合 → 只发 1');
  eq(drawCountFor(3, true), 1, '首回合且已有 3 张 → 1');
  eq(drawCountFor(4, true), 0, '首回合且已满 → 不发');
});

test('发牌：手牌满 4 张时下回合不发牌', () => {
  const s = mk(2, 4242);
  const a = byId(s, s.turn);
  const other = s.players.find((p) => p.id !== a.id);
  setHand(s, a.id, ['beer', 'beer', 'beer', 'beer']); // a 满手 4 张
  setHand(s, other.id, ['cigarette', 'cigarette']); // 固定对手起手 2 张
  setMagazine(s, ['blank', 'blank', 'blank', 'blank']);
  setTurn(s, a.id);
  eq(a.hand.length, 4, 'a 满手 4 张');

  // a 空弹打自己保留回合 → 再空弹打对手结束回合，对手应补到 4 张
  act(s, a.id, { type: 'shoot', targetId: a.id });
  eq(s.turn, a.id, '空弹打自己保留回合');
  act(s, a.id, { type: 'shoot', targetId: other.id });
  eq(other.hand.length, 4, '对手 2 张 → 补 2 张到 4');

  // 对手空弹打 a 交棒回来：a 已满 4 张，不应再发牌
  act(s, other.id, { type: 'shoot', targetId: a.id });
  eq(s.turn, a.id, '回合回到 a');
  eq(a.hand.length, 4, 'a 手牌已满 4 张，不应再发牌');
  eq(checkInvariants(s), [], '不变量');
});

test('发牌：摸牌堆 < 4 张时，弃牌堆洗匀后放到摸牌堆「底下」', () => {
  const s = mk(2, 555);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setHand(s, a.id, ['beer']);
  setHand(s, b.id, ['beer']);

  // 构造：摸牌堆恰好 3 张，其余全部塞进弃牌堆
  const kept = s.drawPile.splice(0, 3);
  s.discard.push(...s.drawPile.splice(0));
  s.drawPile = kept;
  const discardBefore = s.discard.length;
  eq(s.drawPile.length, 3, '摸牌堆 3 张（< 4，满足回收条件）');
  assert(discardBefore > 0, '弃牌堆非空');

  const bHandBefore = b.hand.length; // 1 张
  s.turnNo = 5; // 避开“第一回合只发 1 张”
  setTurn(s, a.id);
  setMagazine(s, ['blank', 'blank']);
  act(s, a.id, { type: 'shoot', targetId: b.id }); // 空弹打别人 → 交棒给 b，触发发牌

  eq(s.discard.length, 0, '弃牌堆被全部回收');
  // 回收的牌放在底部 → 原来那 3 张必须最先被抽走
  eq(b.hand.slice(bHandBefore, bHandBefore + 2), kept.slice(0, 2), '先抽走的应是原本在顶部的那两张');
  eq(s.drawPile.length, 3 - 2 + discardBefore, '摸牌堆 = 原 3 张 - 抽走 2 张 + 回收的弃牌');
  eq(checkInvariants(s), [], '回收后不变量');
});

/* ------------------------- 放大镜 ------------------------- */

test('放大镜：只有使用者本人能看到结果，不泄露给其他人', () => {
  const s = mk(3, 31337);
  setMagazine(s, ['blank', 'live', 'live']);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['magnifier']);

  act(s, a.id, { type: 'use', item: 'magnifier' });
  eq(s.knowledge[a.id], 'blank', '自己看到的是空弹');
  eq(remainingCounts(s), { live: 2, blank: 1, total: 3 }, '弹药数量不变');

  const viewA = viewFor(s, a.id);
  eq(viewA.me.knows, 'blank', '自己视野里能看到');
  for (const other of s.players.filter((p) => p.id !== a.id)) {
    const v = viewFor(s, other.id);
    eq(v.me.knows, null, `${other.id} 不应看到别人的放大镜结果`);
  }
  // 关键：视图里绝不能出现弹匣真实顺序
  const dumped = JSON.stringify(viewA);
  assert(!dumped.includes('"shells"'), '视图不得包含 shells 字段');
  assert(!dumped.includes('知识') && !dumped.includes('__secret'), '视图不得包含内部字段');
});

test('放大镜：用完即进弃牌堆', () => {
  const s = mk(2, 8);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['magnifier']);
  const d = s.discard.length;
  act(s, a.id, { type: 'use', item: 'magnifier' });
  eq(s.discard.length, d + 1, '弃牌堆 +1');
  eq(a.hand.length, 0, '手牌 -1');
});

/* ------------------------- 逆转器 ------------------------- */

test('逆转器：实弹变空弹、空弹变实弹，公开数量同步修正', () => {
  const s = mk(2, 100);
  setMagazine(s, ['live', 'live']);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['inverter']);

  eq(remainingCounts(s), { live: 2, blank: 0, total: 2 }, '逆转前');
  act(s, a.id, { type: 'use', item: 'inverter' });
  eq(remainingCounts(s), { live: 1, blank: 1, total: 2 }, '逆转后数量修正');

  // 再来一次应还原
  setHand(s, a.id, ['inverter']);
  act(s, a.id, { type: 'use', item: 'inverter' });
  eq(remainingCounts(s), { live: 2, blank: 0, total: 2 }, '再次逆转还原');
});

test('逆转器：原本知道结果的人，情报应同步翻转', () => {
  const s = mk(3, 101);
  setMagazine(s, ['live', 'blank']);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['magnifier', 'inverter']);
  act(s, a.id, { type: 'use', item: 'magnifier' });
  eq(s.knowledge[a.id], 'live', '先看到实弹');
  act(s, a.id, { type: 'use', item: 'inverter' });
  eq(s.knowledge[a.id], 'blank', '逆转后情报应变为空弹');
});

/* ------------------------- 啤酒 ------------------------- */

test('啤酒：退出当前这一发并公开类型，且不结束回合', () => {
  const s = mk(3, 11);
  setMagazine(s, ['live', 'blank', 'blank']);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['beer']);
  const turnBefore = s.turn;

  const ev = act(s, a.id, { type: 'use', item: 'beer' });
  const useEv = ev.find((e) => e.t === 'use' && e.item === 'beer');
  eq(useEv.ejected, 'live', '退出的子弹类型公开');
  eq(remainingCounts(s), { live: 0, blank: 2, total: 2 }, '弹匣前进一发');
  eq(s.turn, turnBefore, '啤酒不结束回合');
  assert(legalActions(s, a.id).some((x) => x.type === 'shoot'), '退弹后仍可开枪');
});

/* ------------------------- 手锯 ------------------------- */

test('手锯：本发实弹伤害翻倍，打出后失效', () => {
  const s = mk(2, 202);
  setMagazine(s, ['live', 'live']);
  const a = byId(s, s.turn);
  const b = s.players.find((p) => p.id !== a.id);
  setHand(s, a.id, ['handsaw']);

  act(s, a.id, { type: 'use', item: 'handsaw' });
  eq(s.saw, true, '已锯短枪管');
  act(s, a.id, { type: 'shoot', targetId: b.id });
  eq(b.hp, 3, '实弹 2 点伤害（5 → 3）');
  eq(s.saw, false, '开完枪后手锯失效');
});

test('手锯：打出空弹也会浪费掉', () => {
  const s = mk(2, 203);
  setMagazine(s, ['blank', 'live']);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['handsaw']);
  act(s, a.id, { type: 'use', item: 'handsaw' });
  act(s, a.id, { type: 'shoot', targetId: a.id }); // 空弹打自己，保留回合
  eq(s.saw, false, '空弹也应消耗掉手锯效果');
  eq(a.hp, 5, '空弹不掉血');
  eq(s.turn, a.id, '空弹打自己保留回合');
});

test('手锯：已经锯过时不允许重复使用（避免浪费）', () => {
  const s = mk(2, 204);
  const a = byId(s, s.turn);
  setHand(s, a.id, ['handsaw', 'handsaw']);
  act(s, a.id, { type: 'use', item: 'handsaw' });
  const legal = legalActions(s, a.id);
  assert(!legal.some((x) => x.type === 'use' && x.item === 'handsaw'), '第二次手锯不应出现在合法动作里');
  const res = applyAction(s, a.id, { type: 'use', item: 'handsaw' });
  eq(res.ok, false, '强行提交应被拒绝');
});

/* ------------------------- 香烟 ------------------------- */

test('香烟：恢复 1 点生命值', () => {
  const s = mk(2, 300);
  const a = byId(s, s.turn);
  a.hp = 3;
  setHand(s, a.id, ['cigarette']);
  act(s, a.id, { type: 'use', item: 'cigarette' });
  eq(a.hp, 4, '回血 +1');
});

test('香烟：上限 5 点，满血使用即浪费', () => {
  const s = mk(2, 301);
  const a = byId(s, s.turn);
  a.hp = 5;
  setHand(s, a.id, ['cigarette']);
  act(s, a.id, { type: 'use', item: 'cigarette' });
  eq(a.hp, 5, '不会超过上限');
  eq(a.hand.length, 0, '牌仍然被消耗');
});

/* ------------------------- 手铐 ------------------------- */

test('手铐：被铐的对手跳过下一回合', () => {
  const s = mk(3, 400);
  setMagazine(s, ['blank', 'blank', 'blank']);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  const c = bySeat(s, 3);
  setTurn(s, a.id);
  setHand(s, a.id, ['handcuffs', 'beer']);

  act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
  eq(b.cuffed, true, 'b 被铐住');
  act(s, a.id, { type: 'shoot', targetId: c.id }); // 空弹打别人 → 结束回合
  eq(b.cuffed, false, '被跳过时手铐解除');
  eq(s.turn, c.id, 'b 被跳过，回合直接给 c');
});

test('手铐（回归）：2 人局里被跳过的人不能反过来拿到回合', () => {
  // 用户实测的那一把：神铐住品 → 空弹打自己（保留回合）→ 空弹打品（结束回合）。
  // 记录里「品 被手铐跳过回合」后面紧跟着「品 摸了 2 张牌」，品白拿一个回合。
  // 根因：endTurn 在「其他人都被跳过」时把回合顺延给了 alive[startIdx+1] ——
  // 正是刚刚被跳过、手铐也已经解除的那个人。2 人局里 100% 命中。
  const s = mk(2, 402);
  setMagazine(s, ['blank', 'blank', 'blank', 'blank', 'blank', 'blank']);
  const a = bySeat(s, 1); // 品
  const b = bySeat(s, 2); // 神
  setTurn(s, a.id);
  setHand(s, a.id, ['cigarette']);
  setHand(s, b.id, ['handcuffs', 'cigarette']);

  act(s, a.id, { type: 'shoot', targetId: b.id }); // 空弹打别人 → 交棒
  eq(s.turn, b.id, '回合交给 b');

  const aHandBefore = byId(s, a.id).hand.length;
  act(s, b.id, { type: 'use', item: 'handcuffs', targetId: a.id });
  eq(byId(s, a.id).cuffed, true, 'a 被铐住');
  act(s, b.id, { type: 'shoot', targetId: b.id }); // 空弹打自己 → 保留回合
  eq(s.turn, b.id, '空弹打自己保留回合');

  const ev = act(s, b.id, { type: 'shoot', targetId: a.id }); // 空弹打别人 → 结束回合
  assert(
    ev.some((e) => e.t === 'skip' && e.player === a.id),
    'a 被手铐跳过'
  );
  eq(byId(s, a.id).cuffed, false, 'a 的手铐在跳过时解除');
  eq(s.turn, b.id, 'a 是唯一的对手，被跳过之后回合必须回到 b');
  eq(byId(s, a.id).hand.length, aHandBefore, 'a 一张牌都不该摸到');
  assert(!ev.some((e) => e.t === 'turn' && e.player === a.id), 'a 不该有摸牌事件');
  eq(checkInvariants(s), [], '不变量');
});

test('手铐（回归）：其他人都被锁住时，回合回到自己身上而不是白送给别人', () => {
  const s = mk(3, 403);
  setMagazine(s, ['blank', 'blank', 'blank', 'blank', 'blank', 'blank']);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  const c = bySeat(s, 3);
  setTurn(s, a.id);
  setHand(s, a.id, ['handcuffs', 'handcuffs']);

  act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
  act(s, a.id, { type: 'use', item: 'handcuffs', targetId: c.id });
  const ev = act(s, a.id, { type: 'shoot', targetId: b.id }); // 空弹打别人 → 结束回合

  assert(ev.some((e) => e.t === 'skip' && e.player === b.id), 'b 被跳过');
  assert(ev.some((e) => e.t === 'skip' && e.player === c.id), 'c 被跳过');
  eq(s.turn, a.id, 'b、c 都被跳过，回合回到 a');
  eq(byId(s, b.id).cuffed, false, 'b 手铐解除');
  eq(byId(s, c.id).cuffed, false, 'c 手铐解除');
  assert(!ev.some((e) => e.t === 'turn' && (e.player === b.id || e.player === c.id)), '被跳过的人不该摸牌');
  eq(checkInvariants(s), [], '不变量');
});

test('手铐（回归）：每轮开始时 1 号戴着手铐也要被跳过', () => {
  const s = mk(2, 404);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, b.id);
  setHand(s, b.id, ['handcuffs', 'cigarette']);
  act(s, b.id, { type: 'use', item: 'handcuffs', targetId: a.id });
  eq(byId(s, a.id).cuffed, true, 'a 被铐住');

  // 直接触发换弹（弹匣耗尽）→ 新一轮由 1 号开始，但 1 号还锁着
  setMagazine(s, ['blank']);
  const ev = act(s, b.id, { type: 'shoot', targetId: b.id }); // 打自己打完最后一发 → 换弹
  assert(ev.some((e) => e.t === 'round'), '触发了换弹');
  assert(ev.some((e) => e.t === 'skip' && e.player === a.id), '新一轮开始时 a 被跳过');
  eq(s.turn, b.id, '回合给到 b 而不是被锁住的 a');
  eq(byId(s, a.id).cuffed, false, '手铐解除');
  eq(checkInvariants(s), [], '不变量');
});

test('手铐：不能铐自己，也不能铐已被铐住的人', () => {
  const s = mk(3, 401);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  setHand(s, a.id, ['handcuffs']);
  const legal = legalActions(s, a.id);
  assert(!legal.some((x) => x.type === 'use' && x.item === 'handcuffs' && x.targetId === a.id), '不能铐自己');
  act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
  setHand(s, a.id, ['handcuffs']);
  const legal2 = legalActions(s, a.id);
  assert(
    !legal2.some((x) => x.type === 'use' && x.item === 'handcuffs' && x.targetId === b.id),
    '不能重复铐同一个人'
  );
});

/* ------------------------- 肾上腺素 ------------------------- */

test('肾上腺素：偷一张随机牌并立刻使用（不需要目标的道具）', () => {
  const s = mk(2, 500);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  setMagazine(s, ['live', 'live']);
  a.hp = 3;
  setHand(s, a.id, ['adrenaline']);
  setHand(s, b.id, ['cigarette']); // 对手只有一张确定能偷的牌

  eq(checkInvariants(s), [], '偷之前守恒');
  act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
  eq(a.hp, 4, '偷到香烟并立刻使用 → 回血');
  eq(b.hand.length, 0, '对手的牌被拿走');
  eq(s.pending, null, '不需要二次指定目标');
  eq(checkInvariants(s), [], '偷之后仍然守恒');
});

test('肾上腺素：偷到手铐时需要二次指定目标，且期间牌数守恒', () => {
  const s = mk(3, 501);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  const c = bySeat(s, 3);
  setTurn(s, a.id);
  setMagazine(s, ['live', 'live']);
  setHand(s, a.id, ['adrenaline']);
  setHand(s, b.id, ['handcuffs']);

  act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
  eq(s.pending?.item, 'handcuffs', '挂起等待指定目标');
  eq(checkInvariants(s), [], '挂起期间 28 张牌仍然守恒');
  eq(legalActions(s, a.id).every((x) => x.type === 'target'), true, '此时只能选择目标');

  act(s, a.id, { type: 'target', targetId: c.id });
  eq(c.cuffed, true, '被指定的目标被铐住');
  eq(s.pending, null, '子状态清除');
  eq(checkInvariants(s), [], '结算后守恒');
});

test('肾上腺素：不能偷到肾上腺素本身（防无限递归）', () => {
  const s = mk(2, 502);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  setMagazine(s, ['live', 'live']);
  setHand(s, a.id, ['adrenaline']);
  setHand(s, b.id, ['adrenaline', 'adrenaline']);

  act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
  eq(b.hand.length, 2, '对手的肾上腺素一张都没被偷走');
  eq(s.pending, null, '没有待处理的子状态');
  eq(a.hand.length, 0, '自己的肾上腺素仍然被消耗');
  eq(checkInvariants(s), [], '牌数守恒');
});

test('回归：偷到手铐但没有合法目标时不得死锁', () => {
  // 曾经的 BUG：2 人局里 A 先铐住 B，再用肾上腺素偷到 B 的手铐，
  // 此时「其他存活玩家」全都已被铐，目标池为空 → 游戏卡死。
  const s = mk(2, 909);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  setMagazine(s, ['blank', 'blank', 'blank']);
  setHand(s, a.id, ['handcuffs', 'adrenaline']);
  setHand(s, b.id, ['handcuffs']);

  act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
  eq(b.cuffed, true, 'b 已被铐住');

  const hcInDiscardBefore = s.discard.filter((c) => c === 'handcuffs').length;
  act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
  eq(s.pending, null, '没有合法目标时不应挂起');
  assert(legalActions(s, a.id).length > 0, 'A 仍然有棋可走');
  eq(b.hand.length, 0, '手铐被偷走');
  eq(
    s.discard.filter((c) => c === 'handcuffs').length,
    hcInDiscardBefore + 1,
    '偷来的手铐因无目标而作废进弃牌堆'
  );
  eq(checkInvariants(s), [], '不变量（含死锁检测）');
});

/* ------------------------- 射击 / 回合 ------------------------- */

test('空弹打自己：不掉血、保留回合、可继续操作', () => {
  const s = mk(2, 600);
  setMagazine(s, ['blank', 'live']);
  const a = bySeat(s, 1);
  setTurn(s, a.id);
  act(s, a.id, { type: 'shoot', targetId: a.id });
  eq(a.hp, 5, '空弹不掉血');
  eq(s.turn, a.id, '保留回合');
  assert(legalActions(s, a.id).length > 0, '还能继续操作');
});

test('实弹打自己：掉血且回合结束', () => {
  const s = mk(2, 601);
  setMagazine(s, ['live', 'live']);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  act(s, a.id, { type: 'shoot', targetId: a.id });
  eq(a.hp, 4, '掉 1 血');
  eq(s.turn, b.id, '回合交给对手');
});

test('实弹打死对手：淘汰、手牌进弃牌堆、对局结束并产生胜者', () => {
  const s = mk(2, 602);
  setMagazine(s, ['live', 'live']);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  b.hp = 1;
  const bHand = b.hand.length;
  assert(bHand > 0, 'b 有手牌');
  const discardBefore = s.discard.length;

  act(s, a.id, { type: 'shoot', targetId: b.id });
  eq(b.hp, 0, '血量归零');
  eq(b.alive, false, '被淘汰');
  eq(b.hand.length, 0, '手牌清空');
  eq(s.discard.length, discardBefore + bHand, '手牌全部进弃牌堆');
  eq(s.phase, 'over', '对局结束');
  eq(s.winner, a.id, 'a 获胜');
  eq(checkInvariants(s), [], '结束后不变量');
});

test('多杀：4 人局逐个淘汰，最后一人获胜', () => {
  const s = mk(4, 603);
  const a = bySeat(s, 1);
  setTurn(s, a.id);
  setMagazine(s, ['live', 'live', 'live', 'live']);
  for (const p of s.players) if (p.id !== a.id) p.hp = 1;

  act(s, a.id, { type: 'shoot', targetId: bySeat(s, 2).id });
  eq(s.phase, 'playing', '还有 3 人存活');
  setTurn(s, a.id);
  act(s, a.id, { type: 'shoot', targetId: bySeat(s, 3).id });
  eq(s.phase, 'playing', '还有 2 人存活');
  setTurn(s, a.id);
  act(s, a.id, { type: 'shoot', targetId: bySeat(s, 4).id });
  eq(s.phase, 'over', '只剩 1 人，结束');
  eq(s.winner, a.id, '胜者');
  eq(checkInvariants(s), [], '不变量');
});

test('弹匣打空后自动换弹，并从座位 1 开始新的一轮', () => {
  const s = mk(3, 604);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  setMagazine(s, ['live']); // 只剩一发
  const roundBefore = s.round;

  act(s, a.id, { type: 'shoot', targetId: b.id });
  eq(s.round, roundBefore + 1, '进入下一轮');
  eq(s.turn, bySeat(s, 1).id, '1 号为每轮的开始');
  assert(remainingCounts(s).total > 0, '已重新装填');
  eq(checkInvariants(s), [], '换弹后不变量');
});

test('1 号被淘汰后，新一轮由下一个存活座位开始', () => {
  const s = mk(3, 605);
  const p1 = bySeat(s, 1);
  const p2 = bySeat(s, 2);
  const p3 = bySeat(s, 3);
  p1.alive = false;
  p1.hp = 0;
  setTurn(s, p2.id);
  setMagazine(s, ['live']);
  act(s, p2.id, { type: 'shoot', targetId: p3.id });
  eq(s.round, 2, '进入第二轮');
  eq(s.turn, p2.id, '1 号已淘汰 → 由 2 号开始');
});

/* ------------------------- 非法动作 ------------------------- */

test('非法动作不会产生任何副作用', () => {
  const s = mk(3, 700);
  const a = bySeat(s, 1);
  const b = bySeat(s, 2);
  setTurn(s, a.id);
  setHand(s, a.id, ['beer']);

  const snapshot = JSON.stringify({
    hp: s.players.map((p) => p.hp),
    hands: s.players.map((p) => p.hand),
    discard: s.discard.length,
    magazine: s.magazine,
    seq: s.seq,
  });

  const bad = [
    { type: 'use', item: 'cigarette' }, // 手里没有
    { type: 'use', item: 'handcuffs', targetId: b.id }, // 手里没有
    { type: 'shoot', targetId: 'nobody' }, // 目标不存在
    { type: 'target', targetId: b.id }, // 没有挂起状态
    { type: 'nonsense' },
  ];
  for (const action of bad) {
    const res = applyAction(s, a.id, action);
    eq(res.ok, false, `应被拒绝: ${JSON.stringify(action)}`);
  }
  // 不是自己回合也不能动
  const res = applyAction(s, b.id, { type: 'shoot', targetId: a.id });
  eq(res.ok, false, '非当前回合玩家不能行动');

  eq(
    JSON.stringify({
      hp: s.players.map((p) => p.hp),
      hands: s.players.map((p) => p.hand),
      discard: s.discard.length,
      magazine: s.magazine,
      seq: s.seq,
    }),
    snapshot,
    '状态完全没有变化'
  );
});

/* ------------------------- 视图裁剪 ------------------------- */

test('视图裁剪：看不到他人手牌内容与弹匣顺序', () => {
  const s = mk(4, 800);
  const a = bySeat(s, 1);
  const v = viewFor(s, a.id);

  eq(v.me.hand, byId(s, a.id).hand, '自己的手牌可见');
  for (const pv of v.players) {
    assert(!('hand' in pv), `玩家视图不得包含 hand 字段: ${pv.id}`);
    assert(typeof pv.handCount === 'number', '只暴露手牌张数');
  }
  assert(!('shells' in v.magazine), '不得暴露弹匣顺序');
  assert(!('drawPile' in v) && !('discard' in v), '不得暴露摸牌堆/弃牌堆内容');
  assert(!('seed' in v) && !JSON.stringify(v).includes('"seed"'), '不得暴露随机种子');
  assert(!JSON.stringify(v).includes('"live","'), '不得以数组形式泄露弹序');
});

test('视图裁剪：非当前回合玩家的合法动作为空', () => {
  const s = mk(3, 801);
  const a = bySeat(s, 1);
  const other = s.players.find((p) => p.id !== a.id);
  eq(viewFor(s, other.id).me.legal, [], '不是自己的回合就没有合法动作');
  assert(viewFor(s, a.id).me.legal.length > 0, '当前回合玩家有合法动作');
});

/* ------------------------- 牌堆参数 ------------------------- */

test('道具总量：7 种 × 4 张 = 28 张', () => {
  eq(ALL_ITEMS.length, 7, '道具种类');
  eq(COPIES_PER_ITEM, 4, '每种份数');
  eq(TOTAL_CARDS, 28, '总张数');
  eq(MAX_HP, 5, '血量上限');
});

await run();