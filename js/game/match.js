/**
 * Shell Gambit — 一局对局的驱动
 *
 * 把「引擎 + AI + 节奏控制」封装在一起，房主端和单机模式共用同一份代码，
 * 保证人机对局与联机对局的规则、节奏、AI 完全一致。
 */

import { aiDecide, createAiMemory } from '../ai/ai.js';
import { applyAction, createGame, legalActions, viewFor } from '../engine/engine.js';

export class Match {
  /**
   * @param {object} opts
   * @param {{id:string,name:string,isAi?:boolean}[]} opts.players
   * @param {number}   [opts.seed]
   * @param {number}   [opts.aiDelayMs] AI 思考时长（让真人看得清它在干什么）
   * @param {()=>void} [opts.onUpdate]  每次状态变化后回调
   */
  constructor({ players, seed, aiDelayMs = 900, onUpdate }) {
    if (players.length < 2 || players.length > 4) {
      throw new Error('一局需要 2–4 名参与者');
    }
    this.aiDelayMs = aiDelayMs;
    this.onUpdate = onUpdate || (() => {});
    this.state = createGame({
      players: players.map((p) => ({ id: p.id, name: p.name })),
      seed,
    });
    this.memories = {};
    this.isAi = {};
    for (const p of players) {
      this.memories[p.id] = createAiMemory();
      this.isAi[p.id] = !!p.isAi;
    }
    this.aiTimer = null;
    this.disposed = false;
    /** 上一个「正在思考」的 AI，用来判断是不是刚换人 */
    this.lastAiTurn = null;
    /** 最近一次 AI 的决策理由，供 UI 展示「它在想什么」 */
    this.lastAiReason = null;
    this.lastAiPlayer = null;
  }

  /** 开始（会立刻推进 AI 的回合） */
  start() {
    this._afterChange();
  }

  /** 某人退出后由 AI 接管，保证对局能继续 */
  setAi(playerId, isAi) {
    this.isAi[playerId] = !!isAi;
    if (isAi) this._afterChange();
  }

  /** 该玩家是否是 AI */
  isAiPlayer(playerId) {
    return !!this.isAi[playerId];
  }

  /** 提交一个真人动作 */
  submit(playerId, action) {
    if (this.disposed) return { ok: false, error: '对局已结束' };
    if (this.state.phase !== 'playing') return { ok: false, error: '对局已结束' };
    if (this.state.turn !== playerId) return { ok: false, error: '还没轮到你' };
    const res = applyAction(this.state, playerId, action);
    if (res.ok) this._afterChange();
    return res;
  }

  /** 取某个玩家能看到的状态（已裁剪，绝不包含隐藏信息） */
  viewFor(playerId) {
    return viewFor(this.state, playerId);
  }

  /** 当前回合玩家的合法动作（房主内部使用） */
  legalFor(playerId) {
    return legalActions(this.state, playerId);
  }

  /** 状态变化后：通知上层，并安排 AI 的下一步 */
  _afterChange() {
    if (this.disposed) return;
    clearTimeout(this.aiTimer);
    this.aiTimer = null;

    this.onUpdate();

    const s = this.state;
    if (s.phase !== 'playing') return;
    if (!this.isAi[s.turn]) {
      this.lastAiTurn = null;
      return;
    }

    // 回合刚开始时慢一点，让真人看清轮到谁了；
    // 同一个人连续行动（空弹打自己会保留回合）就快一点，不然等着会很闷
    const newTurn = this.lastAiTurn !== s.turn;
    this.lastAiTurn = s.turn;
    const delay = newTurn ? this.aiDelayMs : Math.max(260, Math.round(this.aiDelayMs * 0.55));

    this.aiTimer = setTimeout(() => this._runAi(), delay);
  }

  /** 让 AI 走一步 */
  _runAi() {
    if (this.disposed) return;
    const s = this.state;
    if (s.phase !== 'playing') return;
    const pid = s.turn;
    if (!this.isAi[pid]) return;

    const decision = aiDecide(s, pid, this.memories[pid]);
    if (!decision) {
      // 理论上不会发生；兜底随便走一个合法动作，避免整局卡住
      const legal = legalActions(s, pid);
      if (!legal.length) {
        console.error('AI 没有任何合法动作，对局无法继续');
        return;
      }
      applyAction(s, pid, legal[0]);
      this._afterChange();
      return;
    }

    this.lastAiPlayer = pid;
    this.lastAiReason = decision.reason;

    const res = applyAction(s, pid, decision.action);
    if (!res.ok) {
      // 万一 AI 算错了，用第一个合法动作兜底，绝不让对局卡死
      const legal = legalActions(s, pid);
      if (legal.length) applyAction(s, pid, legal[0]);
    }
    this._afterChange();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.aiTimer);
    this.aiTimer = null;
  }
}