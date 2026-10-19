/**
 * Shell Gambit — AI 自对弈压力测试
 *
 * 让 2/3/4 名 AI 反复对局，每一步都校验引擎不变量，
 * 用来找规则漏洞、死锁、状态漂移、非法动作。
 *
 * 运行：
 *   node tests/sim.mjs             # 默认每种人数 3000 局
 *   node tests/sim.mjs 20000       # 每种人数 20000 局
 */

import { applyAction, checkInvariants, createGame, remainingCounts } from '../js/engine/engine.js';
import { aiDecide, createAiMemory } from '../js/ai/ai.js';

const STEP_LIMIT = 4000; // 单局最大步数，超过即判定为疑似死锁

/**
 * 跑一局，返回统计数据。
 * @param {number} n 玩家人数
 * @param {number} seed 随机种子
 */
export function runGame(n, seed, { onIssue } = {}) {
  const players = Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `AI${i + 1}`,
  }));
  const state = createGame({ players, seed });
  const memories = {};
  for (const p of state.players) memories[p.id] = createAiMemory();

  const stats = {
    seed,
    players: n,
    steps: 0,
    turns: 0,
    rounds: 0,
    winner: null,
    itemsUsed: {},
    events: {},
    issues: [],
  };

  const issue = (msg) => {
    stats.issues.push(msg);
    if (onIssue) onIssue(msg);
  };

  let guard = 0;
  while (state.phase === 'playing') {
    if (guard++ >= STEP_LIMIT) {
      issue(`超过 ${STEP_LIMIT} 步仍未结束（疑似死锁）`);
      break;
    }
    const pid = state.turn;
    if (!pid) {
      issue('没有当前回合玩家');
      break;
    }
    const decision = aiDecide(state, pid, memories[pid]);
    if (!decision) {
      issue(`AI 在还有合法动作时返回了 null（${pid}）`);
      break;
    }
    const before = {
      turn: state.turn,
      seq: state.seq,
      hands: state.players.map((p) => p.hand.length).join(','),
      counts: JSON.stringify(remainingCounts(state)),
    };
    const res = applyAction(state, pid, decision.action);
    if (!res.ok) {
      issue(`AI 提交了非法动作: ${JSON.stringify(decision.action)} → ${res.error}`);
      break;
    }

    // 每一步都必须真正推进状态，否则就是死循环
    if (state.seq === before.seq) {
      issue(`动作没有产生任何事件（状态未推进）: ${JSON.stringify(decision.action)}`);
      break;
    }

    const bad = checkInvariants(state);
    if (bad.length) {
      issue(`不变量被打破: ${bad.join('; ')}`);
      break;
    }

    stats.steps++;
    for (const e of res.events) {
      stats.events[e.t] = (stats.events[e.t] || 0) + 1;
      if (e.t === 'use') stats.itemsUsed[e.item] = (stats.itemsUsed[e.item] || 0) + 1;
    }
  }

  stats.turns = state.turnNo;
  stats.rounds = state.round;
  stats.winner = state.winner;

  if (!stats.issues.length) {
    const alive = state.players.filter((p) => p.alive);
    if (state.phase !== 'over') issue('循环结束但对局未结束');
    else if (alive.length !== 1) issue(`对局结束但存活人数为 ${alive.length}`);
    else if (state.winner !== alive[0].id) issue('胜者与唯一存活玩家不一致');
  }

  return stats;
}

/* ----------------------------- 批量跑 ----------------------------- */

function main() {
  const perCount = Number(process.argv[2] || 3000);
  const startTime = Date.now();

  console.log(`Shell Gambit 自对弈测试：每种人数 ${perCount} 局\n`);

  const allIssues = [];
  const totals = {};
  const itemCoverage = {};
  const eventCoverage = {};

  for (const n of [2, 3, 4]) {
    const t0 = Date.now();
    let wins = {};
    let turnSum = 0;
    let roundSum = 0;
    let stepSum = 0;
    let itemTotal = 0;

    for (let i = 0; i < perCount; i++) {
      // 种子覆盖不同量级，避免随机性只集中在某一区间
      const seed = (i * 2654435761 + n * 40503) >>> 0;
      const s = runGame(n, seed);
      if (s.issues.length) {
        for (const msg of s.issues) allIssues.push(`[${n}人 seed=${seed}] ${msg}`);
      }
      wins[s.winner] = (wins[s.winner] || 0) + 1;
      turnSum += s.turns;
      roundSum += s.rounds;
      stepSum += s.steps;
      for (const [k, v] of Object.entries(s.itemsUsed)) {
        itemCoverage[k] = (itemCoverage[k] || 0) + v;
        itemTotal += v;
      }
      for (const [k, v] of Object.entries(s.events)) {
        eventCoverage[k] = (eventCoverage[k] || 0) + v;
      }
    }

    const ms = Date.now() - t0;
    totals[n] = { turnSum, roundSum, stepSum, wins, itemTotal, ms };
    const winList = Object.entries(wins)
      .sort()
      .map(([k, v]) => `${k}:${((v / perCount) * 100).toFixed(1)}%`)
      .join('  ');
    console.log(
      `  ${n} 人局 × ${perCount}：平均 ${(turnSum / perCount).toFixed(1)} 回合 / ` +
        `${(roundSum / perCount).toFixed(1)} 轮 / ${(stepSum / perCount).toFixed(1)} 步  ` +
        `(${(ms / 1000).toFixed(1)}s)`
    );
    console.log(`      胜率分布（按玩家 id）：${winList}`);
  }

  console.log('\n道具使用覆盖（全部 7 种都应当出现）：');
  const ITEM_NAMES = {
    magnifier: '放大镜',
    inverter: '逆转器',
    adrenaline: '肾上腺素',
    beer: '啤酒',
    handsaw: '手锯',
    cigarette: '香烟',
    handcuffs: '手铐',
  };
  for (const [k, label] of Object.entries(ITEM_NAMES)) {
    const v = itemCoverage[k] || 0;
    const flag = v > 0 ? '\u2713' : '\u2717 未被使用！';
    console.log(`  ${label.padEnd(6, '　')} ${String(v).padStart(8)} 次  ${flag}`);
    if (v === 0) allIssues.push(`道具「${k}」在 ${perCount * 3} 局中从未被 AI 使用（覆盖面不足）`);
  }

  console.log('\n事件覆盖：');
  const EVENT_NAMES = {
    round: '新一轮装填',
    turn: '回合开始发牌',
    shoot: '开枪',
    use: '使用道具',
    elim: '玩家被淘汰',
    skip: '手铐跳过回合',
    recycle: '弃牌堆回收',
    over: '对局结束',
  };
  for (const [k, label] of Object.entries(EVENT_NAMES)) {
    const v = eventCoverage[k] || 0;
    const flag = v > 0 ? '\u2713' : '\u2717 未覆盖！';
    console.log(`  ${label.padEnd(12, '　')} ${String(v).padStart(8)} 次  ${flag}`);
    if (v === 0) allIssues.push(`事件「${k}」从未发生（覆盖面不足）`);
  }

  // 复现性：同样种子必须得到完全一样的对局
  console.log('\n复现性检查（相同种子必须完全一致）：');
  let reproOk = true;
  for (const n of [2, 3, 4]) {
    for (const seed of [1, 7, 12345, 999983]) {
      const a = runGame(n, seed);
      const b = runGame(n, seed);
      if (a.winner !== b.winner || a.steps !== b.steps || a.rounds !== b.rounds || a.turns !== b.turns) {
        allIssues.push(`[${n}人 seed=${seed}] 不可复现：${a.winner}/${a.steps} vs ${b.winner}/${b.steps}`);
        reproOk = false;
      }
    }
  }
  console.log(reproOk ? '  \u2713 全部一致' : '  \u2717 存在不一致');

  const total = Date.now() - startTime;
  console.log(`\n总耗时 ${(total / 1000).toFixed(1)}s`);

  if (allIssues.length) {
    console.log(`\n\u2717 发现 ${allIssues.length} 个问题：`);
    const uniq = [...new Set(allIssues)];
    for (const m of uniq.slice(0, 40)) console.log(`  - ${m}`);
    if (uniq.length > 40) console.log(`  ... 另有 ${uniq.length - 40} 类`);
    process.exit(1);
  }
  console.log('\n\u2713 全部对局健康：无非法动作、无死锁、无不变量破坏、道具与事件全覆盖。');
}

main();