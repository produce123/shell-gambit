/**
 * 联网集成测试
 *
 * 在 Node 里跑真实信令通道（公共 MQTT）与真实会话层：
 *   · Node 没有 RTCPeerConnection，所以 PeerLink 会自动降级为「中转模式」——
 *     这正好把「兜底路径」完完整整测了一遍
 *   · 浏览器里同一套代码会优先走 WebRTC 直连，降级逻辑则完全一致
 *
 * 需要联网。若一条公共通道都连不上，会打印跳过而不是判失败（避免网络抖动误报）。
 *
 * 运行： node tests/net.test.mjs
 */

import { aiDecideFromView, createAiMemory } from '../js/ai/ai.js';
import { LINK, makePeerId, makeRoomCode } from '../js/net/protocol.js';
import { ClientSession, HostSession } from '../js/net/session.js';
import { assert, eq, run, test } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待条件成立 */
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(120);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

test('联网：房间号配对 → 大厅 → 开局 → 状态同步 → 动作提交', async () => {
  const room = makeRoomCode();
  const hostId = `H${makePeerId()}`;
  const idA = `A${makePeerId()}`;
  const idB = `B${makePeerId()}`;

  const host = new HostSession({ room, player: { id: hostId, name: '甲' } });
  let channels = 0;
  try {
    channels = await host.open();
  } catch (e) {
    console.log(`      （跳过：公共信令不可用 — ${e.message}）`);
    return;
  }
  if (channels === 0) {
    console.log('      （跳过：没有可用的公共信令通道）');
    host.close();
    return;
  }
  console.log(`      房间 ${room}，信令通道 ${channels} 条`);

  const clientA = new ClientSession({ room, player: { id: idA, name: '乙' } });
  const clientB = new ClientSession({ room, player: { id: idB, name: '丙' } });

  const views = new Map();
  const starts = new Map();
  for (const c of [clientA, clientB]) {
    c.on('state', (v) => views.set(c.selfId, v));
    c.on('start', (p) => starts.set(c.selfId, p));
  }
  const hostViews = [];
  host.on('state', (v) => hostViews.push(v));

  try {
    // --- 1. 配对 ---
    await Promise.all([clientA.open(), clientB.open()]);
    assert(clientA.hostId === hostId, '客户端 A 应找到房主');
    assert(clientB.hostId === hostId, '客户端 B 应找到房主');

    // --- 2. 大厅：房主与两个客户端都应看到 3 个人 ---
    await waitFor(() => host.roster.size === 3, 15000, '房主看到 3 名参与者');
    const names = [...host.roster.values()].map((p) => p.name).sort();
    eq(names, ['丙', '乙', '甲'], '房主名册');

    // 客户端也应通过 LOBBY 看到彼此
    await waitFor(
      () => clientA.participants.length === 3 && clientB.participants.length === 3,
      15000,
      '客户端看到名册'
    );

    // --- 3. 互动消息（鲜花/鸡蛋） ---
    console.log(`      房主通道：${JSON.stringify(host.bus.status().channels.map((c) => `${c.id}:${c.state}`))}`);
    const gotReaction = new Promise((resolve) => {
      clientB.on('reaction', (r) => resolve(r));
    });
    clientA.react('egg', idB);
    const reaction = await Promise.race([gotReaction, sleep(25000).then(() => null)]);
    assert(reaction, '客户端 B 应该收到扔鸡蛋事件');
    eq(reaction.kind, 'egg', '互动类型');
    eq(reaction.from, idA, '互动发起者');
    eq(reaction.targetId, idB, '互动目标');

    // --- 4. 开局 ---
    assert(host.canStart(), '3 人应当可以开局');
    assert(host.beginGame(), '开局应当成功');

    await waitFor(() => views.has(idA) && views.has(idB) && hostViews.length > 0, 25000, '收到首帧状态');
    await waitFor(() => starts.has(idA) && starts.has(idB), 15000, '收到开局包');

    // 开局包里绝对不能带随机种子
    for (const [, payload] of starts) {
      assert(!('seed' in payload), '开局包不得泄露随机种子');
      eq(payload.players.length, 3, '开局包人数');
    }

    // --- 5. 视图裁剪：每个人只能看到自己的手牌 ---
    for (const [pid, v] of views) {
      assert(v.me, `${pid} 视野应包含自己`);
      eq(v.me.id, pid, '视野里的自己');
      assert(!('shells' in v.magazine), `${pid} 不得看到弹匣顺序`);
      for (const p of v.players) assert(!('hand' in p), `${pid} 不得看到 ${p.id} 的手牌内容`);
      const dumped = JSON.stringify(v);
      assert(!dumped.includes('"seed"'), `${pid} 视野不得含种子`);
      assert(!('drawPile' in v) && !('discard' in v), `${pid} 视野不得含摸牌堆/弃牌堆`);
      assert(!('knowledge' in v), `${pid} 视野不得含全局情报表`);
    }
    // 三份视图的弹匣剩余数量必须一致（公开信息），但手牌各不相同（私有）
    const counts = [...views.values()].map((v) => `${v.magazine.live}/${v.magazine.blank}`);
    assert(new Set(counts).size === 1, '公开的弹药数量应当全网一致');

    // 传输模式：Node 环境下必然是中转
    assert(
      [clientA.link?.mode, clientB.link?.mode].every((m) => m === LINK.RELAY || m === LINK.DIRECT),
      '链路模式应为 relay 或 direct'
    );

    // --- 6. 用 AI 驱动整局，验证多端状态始终一致 ---
    const mem = { [hostId]: createAiMemory(), [idA]: createAiMemory(), [idB]: createAiMemory() };
    const clients = { [idA]: clientA, [idB]: clientB };
    let clientActions = 0;
    let hostActions = 0;
    let lastSeenSeq = -1;
    const deadline = Date.now() + 120000;
    let finished = false;

    while (Date.now() < deadline) {
      const hv = hostViews[hostViews.length - 1];
      if (hv && hv.phase === 'over') {
        finished = true;
        break;
      }
      // 房主自己（也是真人位，用 AI 代打）
      if (hv?.me?.legal?.length) {
        const d = aiDecideFromView(hv, mem[hostId]);
        if (d) {
          host.submitLocal(d.action);
          hostActions++;
        }
      }
      // 客户端：只有轮到自己时 me.legal 才非空
      for (const [pid, c] of Object.entries(clients)) {
        const v = views.get(pid);
        if (v?.me?.legal?.length && !c.pendingAction) {
          const d = aiDecideFromView(v, mem[pid]);
          if (d) {
            c.submit(d.action);
            clientActions++;
          }
        }
      }

      // 一致性检查：所有端看到的公开信息必须相同
      const latest = [hostViews[hostViews.length - 1], views.get(idA), views.get(idB)];
      if (latest.every(Boolean) && latest[0].seq === latest[1].seq && latest[1].seq === latest[2].seq) {
        const hpSig = (v) => v.players.map((p) => `${p.id}:${p.hp}:${p.alive ? 1 : 0}`).sort().join(',');
        const sig = hpSig(latest[0]);
        for (const v of latest) {
          assert(hpSig(v) === sig, '同一时刻各端看到的血量/存活状态必须一致');
          assert(
            v.magazine.live === latest[0].magazine.live && v.magazine.blank === latest[0].magazine.blank,
            '同一时刻各端看到的弹药数量必须一致'
          );
        }
      }
      if (latest[0]) lastSeenSeq = Math.max(lastSeenSeq, latest[0].seq);

      if (finished) break;
      await sleep(100);
    }

    assert(clientActions > 0, `客户端至少应成功提交过动作（实际 ${clientActions}）`);
    assert(hostActions > 0, '房主至少应成功提交过动作');
    assert(lastSeenSeq > 0, '状态序号应当推进');
    console.log(
      `      对局推进：${lastSeenSeq} 个状态帧，客户端动作 ${clientActions} 次，房主动作 ${hostActions} 次，` +
        `${finished ? '已分出胜负' : '达到时间上限（不影响结论）'}`
    );
  } finally {
    clientA.close();
    clientB.close();
    host.close();
    await sleep(400);
  }
});

await run();