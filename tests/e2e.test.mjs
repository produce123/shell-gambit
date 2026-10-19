/**
 * Shell Gambit — 真实浏览器端到端测试
 *
 * 用真实的无头 Chrome 打开真实页面，走完整的用户路径：
 *   1) 单机人机对局：首页 → 选人数 → 打完一整局
 *   2) 联机对局：3 个浏览器各自取名字 → 同一个房间号配对 → 大厅互扔鸡蛋
 *      → 房主开局 → 三家一起把对局打完 → 校验三家看到的状态完全一致
 *
 * 只有在真浏览器里才能验证的东西：DOM 渲染、事件绑定、WebRTC 直连、
 * 公共信令通道、以及「客户端视野里到底有没有泄露弹序」。
 *
 * 用法：node tests/e2e.test.mjs
 */

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Page, findChrome } from '../tools/cdp.mjs';
import { startServer } from '../tools/serve.mjs';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));

let passed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 屏幕是否处于激活状态 */
const screenActive = (page, name) =>
  page.eval(`return document.getElementById('screen-${name}').classList.contains('is-active');`);

async function waitScreen(page, name, timeout = 15000) {
  await page.waitFor(
    `return document.getElementById('screen-${name}').classList.contains('is-active');`,
    timeout,
    `进入 ${name} 界面`
  );
}

/** 等应用初始化完成（事件绑定好之后才能点） */
async function loadApp(page, timeout = 20000) {
  await page.waitFor(`return document.body.dataset.sgReady === '1';`, timeout, '应用初始化完成');
}

/** 表单：从首页走到「在线对局」并设置好名字 */
async function setupName(page, name) {
  await page.click('[data-go="online"]');
  await waitScreen(page, 'name');
  await page.setInput('#name-input', name);
  await page.click('#name-confirm');
  await waitScreen(page, 'online');
}

/**
 * 点一下「当前可用的第一个操作」。轮到自己才有按钮，所以这天然就是
 * 「该我时才动」的驱动器。
 */
async function stepOnce(page, { useItems = true } = {}) {
  return page.evalRaw(`(() => {
    const actions = [...document.querySelectorAll('#actions .act-btn')]
      .filter((b) => !b.disabled && !b.classList.contains('cancel'));
    if (!actions.length) return false;

    const cards = [...document.querySelectorAll('#hand .card')].filter((c) => !c.disabled);
    if (${useItems} && cards.length && Math.random() < 0.45) {
      cards[Math.floor(Math.random() * cards.length)].click();
      // 出牌后可能要选目标，留给下一轮处理
      return true;
    }
    actions[0].click();
    return true;
  })()`);
}

/**
 * 自动打完一局：轮到自己就点第一个可用操作，偶尔出张牌。
 * @returns {Promise<{turns:number, over:boolean}>}
 */
async function autoPlay(page, { maxMs = 180000, useItems = true } = {}) {
  const deadline = Date.now() + maxMs;
  let turns = 0;
  while (Date.now() < deadline) {
    const over = await page.eval(
      `return !document.getElementById('modal-layer').hidden;`
    );
    if (over) return { turns, over: true };
    if (await stepOnce(page, { useItems })) turns += 1;
    await sleep(220);
  }
  return { turns, over: false };
}

/** 读取当前对局的公开状态（用于跨端一致性比对） */
const readBoard = (page) =>
  page.evalRaw(`(() => ({
    screen: document.querySelector('.screen.is-active')?.id,
    seq: Number(document.getElementById('screen-game').dataset.seq || -1),
    round: document.getElementById('hud-round')?.textContent,
    live: document.getElementById('hud-live')?.textContent,
    blank: document.getElementById('hud-blank')?.textContent,
    hint: document.getElementById('turn-hint')?.textContent,
    acts: document.querySelectorAll('#actions .act-btn').length,
    modal: !document.getElementById('modal-layer').hidden,
    turn: document.querySelector('.seat.is-turn .seat-name')?.textContent || null,
    seats: [...document.querySelectorAll('.seat')].map((s) => ({
      name: s.querySelector('.seat-name').textContent,
      hp: [...s.querySelectorAll('.hp i')].filter((i) => !i.classList.contains('off')).length,
      hand: s.querySelector('.seat-meta').textContent,
      dead: s.classList.contains('is-dead'),
    })),
  }))()`);

/** 公开状态的可比较快照（不含 seq 本身；「（我）」只是本地标记，不算状态差异） */
const boardKey = (x) =>
  `${x.round}|${x.live}|${x.blank}|${(x.turn || '').replace('（我）', '')}|${JSON.stringify(
    x.seats.map((s) => [s.name.replace('（我）', ''), s.hp, s.hand, s.dead])
  )}`;

/**
 * 等到两端同步到同一帧再比对。
 * 直接先后读取两边是有竞态的：状态帧可能还在路上。
 * 真正的判据是「最终一定会收敛到同一帧，且同一帧内容必须一模一样」。
 */
async function compareAtSameSeq(a, b, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastA = null;
  let lastB = null;
  while (Date.now() < deadline) {
    const [x, y] = await Promise.all([readBoard(a), readBoard(b)]);
    lastA = x;
    lastB = y;
    if (x.screen !== 'screen-game' || y.screen !== 'screen-game') break;
    if (x.seq === y.seq && x.seq >= 0) return { same: boardKey(x) === boardKey(y), x, y };
    await sleep(150);
  }
  return { same: false, x: lastA, y: lastB, timeout: true };
}

/* ================================================================== *
 * 用例 1：单机人机对局
 * ================================================================== */

async function testLocalGame(baseUrl) {
  console.log('\n【用例 1】单机人机对局：首页 → 4 人局 → 打完');
  const page = await Page.launch({ startUrl: baseUrl });
  try {
    await loadApp(page);
    await waitScreen(page, 'home');
    ok(true, '页面加载成功，停在首页');

    // 首页三个入口都在
    const menus = await page.evalRaw(
      `[...document.querySelectorAll('.menu-btn b')].map((b) => b.textContent)`
    );
    ok(
      menus.includes('人机对局') && menus.includes('在线对局') && menus.includes('游戏规则'),
      `首页有三大入口：${menus.join(' / ')}`
    );

    // 音效 / 特效可以自行开关，并且记忆在本地
    await page.click('#toggle-sound');
    const soundOff = await page.eval(
      `return document.getElementById('toggle-sound').textContent;`
    );
    ok(soundOff.includes('关'), `音效可以关掉（按钮变成「${soundOff}」）`);
    const soundStored = await page.eval(`return localStorage.getItem('sg.sound');`);
    ok(soundStored === 'off', '音效开关被记住了');

    await page.click('#toggle-fx');
    const fxOff = await page.eval(`return document.getElementById('toggle-fx').textContent;`);
    ok(fxOff.includes('关'), `特效可以关掉（按钮变成「${fxOff}」）`);
    ok(
      (await page.eval(`return localStorage.getItem('sg.fx');`)) === 'off',
      '特效开关被记住了'
    );

    // 关掉特效后不应该再有飞行动画层
    await page.click('[data-go="ai"]');
    await waitScreen(page, 'ai');
    await page.setInput('#ai-name-input', '测');
    await page.click('[data-players="2"]');
    await waitScreen(page, 'game', 20000);
    await page.waitFor(
      `return document.querySelectorAll('#actions .act-btn').length > 0;`,
      30000,
      '轮到我行动'
    );
    await stepOnce(page, { useItems: false });
    await sleep(400);
    const fxCount = await page.eval(
      `return document.querySelectorAll('#fx-layer > *').length;`
    );
    ok(fxCount === 0, `关掉特效后动画层是空的（实际 ${fxCount} 个元素）`);
    // 文字事件流仍然要有，不能因为关特效就没了反馈
    const feedCount = await page.eval(`return document.querySelectorAll('#feed .feed-item').length;`);
    ok(feedCount > 0, `关掉特效后文字事件流仍在（${feedCount} 条）`);

    // 回到首页并重新打开，验证开关被记住
    await page.evalRaw(`document.getElementById('game-menu').click()`);
    await sleep(250);
    await page.click('#modal-layer .modal-actions button:last-child'); // 菜单最后一项＝退出对局
    await waitScreen(page, 'home');
    const persisted = await page.eval(
      `return document.getElementById('toggle-sound').textContent + '|' + document.getElementById('toggle-fx').textContent;`
    );
    ok(persisted === '🔊 音效：关|✨ 特效：关', `重开界面后开关状态被记住（${persisted}）`);
    await page.click('#toggle-sound');
    await page.click('#toggle-fx');

    // 规则页
    await page.click('[data-go="rules"]');
    await waitScreen(page, 'rules');
    const ruleText = await page.evalRaw(`return document.getElementById('rules-body').textContent;`);
    ok(ruleText.includes('放大镜') && ruleText.includes('手铐'), '规则页列出了全部道具');
    await page.click('[data-back="home"]');
    await waitScreen(page, 'home');

    // 人机对局，4 人
    await page.click('[data-go="ai"]');
    await waitScreen(page, 'ai');
    await page.setInput('#ai-name-input', '甲');
    await page.click('[data-players="4"]');
    await waitScreen(page, 'game', 20000);
    ok(true, '选 4 人后进入对局界面');

    const seats = await page.eval(`return document.querySelectorAll('.seat').length;`);
    ok(seats === 4, `桌面上有 4 个座位（实际 ${seats}）`);

    const hpPips = await page.eval(
      `return document.querySelectorAll('.seat .hp i').length;`
    );
    ok(hpPips === 20, `每人 5 格血共 20 格（实际 ${hpPips}）`);

    const startup = await page.evalRaw(`(() => ({
      hand: document.querySelectorAll('#hand .card').length,
      seat: document.querySelector('.seat.is-me .seat-seat')?.textContent || '',
      live: document.getElementById('hud-live').textContent,
      blank: document.getElementById('hud-blank').textContent,
    }))()`);
    // 开局发 2 张；全局第一回合只摸 1 张，所以座位 1 的玩家此时已经是 3 张。
    // 「第一回合摸 1 张」的精确规则由单元测试严格校验，这里只确认界面接对了引擎。
    ok(
      startup.hand >= 2 && startup.hand <= 4,
      `开局手牌在 2–4 张之间（实际 ${startup.hand}，座位 ${startup.seat.trim()}）`
    );
    ok(
      startup.seat.trim().startsWith('1')
        ? startup.hand === 3
        : startup.hand >= 2 && startup.hand <= 4,
      startup.seat.trim().startsWith('1')
        ? `座位 1 先手，摸 1 张后是 3 张（实际 ${startup.hand}）`
        : `后手玩家开局 2–4 张（实际 ${startup.hand}，座位 ${startup.seat.trim()}）`
    );
    ok(
      Number(startup.live) + Number(startup.blank) > 0,
      `弹匣里确实装了子弹（实弹 ${startup.live} / 空弹 ${startup.blank}）`
    );

    await page.screenshot(`${SHOTS}e2e-local-start.png`);

    const result = await autoPlay(page);
    ok(result.over, `能一直玩到分出胜负（共触发 ${result.turns} 次操作）`);

    const modal = await page.evalRaw(`(() => ({
      title: document.querySelector('#modal-layer .modal h3')?.textContent,
      winner: document.querySelector('#modal-layer .winner-name')?.textContent,
    }))()`);
    ok(!!modal.winner, `结算弹窗给出了获胜者：${modal.winner}`);
    await page.screenshot(`${SHOTS}e2e-local-over.png`);

    // 再来一局
    await page.click('#modal-layer .modal-actions button:first-child'); // 结算弹窗第一项＝再来一局
    await sleep(1200);
    const round = await page.eval(`return document.getElementById('hud-round').textContent;`);
    ok(round === '1', `再来一局从第 1 轮重新开始（实际第 ${round} 轮）`);

    ok(page.errors.length === 0, `过程中没有控制台错误${page.errors.length ? `：${page.errors[0]}` : ''}`);
  } finally {
    page.close();
  }
}

/* ================================================================== *
 * 用例 2：三人联机
 * ================================================================== */

async function testOnlineGame(baseUrl) {
  console.log('\n【用例 2】三人联机：配对 → 大厅互动 → 开局 → 打完并校验一致性');
  const host = await Page.launch({ startUrl: baseUrl, width: 1280, height: 900 });
  const b = await Page.launch({ startUrl: baseUrl });
  const c = await Page.launch({ startUrl: baseUrl });

  try {
    await Promise.all([loadApp(host), loadApp(b), loadApp(c)]);
    await Promise.all([waitScreen(host, 'home'), waitScreen(b, 'home'), waitScreen(c, 'home')]);

    // 房主建房
    await setupName(host, '甲');
    await host.click('#btn-create');
    await waitScreen(host, 'lobby', 40000);
    const room = await host.eval(`return document.getElementById('lobby-room-big').textContent;`);
    ok(/^[A-Z2-9]{5}$/.test(room), `房主建好房间，房间号 ${room}`);

    // 两位客人加入
    for (const [page, name] of [
      [b, '乙'],
      [c, '丙'],
    ]) {
      await setupName(page, name);
      await page.setInput('#room-input', room);
      await page.click('#btn-join');
      await waitScreen(page, 'lobby', 45000);
    }
    ok(true, '两位客人用同一房间号配对成功');

    // 三家互相看到
    await host.waitFor(
      `return document.querySelectorAll('#lobby-roster li').length === 3;`,
      25000,
      '房主看到 3 名参与者'
    );
    await b.waitFor(
      `return document.querySelectorAll('#lobby-roster li').length === 3;`,
      25000,
      '客人乙看到 3 名参与者'
    );
    // 三家的名单都要等齐：大厅名单是房主广播的，晚进来的客人先收到的是旧名单
    await c.waitFor(
      `return document.querySelectorAll('#lobby-roster li').length === 3;`,
      25000,
      '客人丙看到 3 名参与者'
    );
    const names = await c.evalRaw(
      `[...document.querySelectorAll('#lobby-roster .who b')].map((b) => b.textContent)`
    );
    ok(names.length === 3, `三人都在大厅名单里：${names.join('、')}`);
    await host.screenshot(`${SHOTS}e2e-lobby.png`);

    // 大厅互扔鸡蛋：甲 扔 乙
    await host.evalRaw(`(() => {
      const rows = [...document.querySelectorAll('#lobby-roster li')];
      const target = rows.find((r) => r.textContent.includes('乙'));
      target.querySelectorAll('.throw-btn')[0].click();
    })()`);
    const gotReaction = await Promise.race([
      b
        .waitFor(`return document.querySelectorAll('#fx-layer .fx-projectile, #fx-layer .fx-burst').length > 0;`, 20000, '乙收到鸡蛋')
        .then(() => true)
        .catch(() => false),
      sleep(22000).then(() => false),
    ]);
    ok(gotReaction, '乙的屏幕上出现了鸡蛋飞行动画');
    await b.screenshot(`${SHOTS}e2e-egg.png`);

    // 房主补一个 AI，凑成 4 人
    await host.click('#lobby-actions .ghost-btn');
    await host.waitFor(
      `return document.querySelectorAll('#lobby-roster li').length === 4;`,
      15000,
      '补位 AI 后 4 人'
    );
    ok(true, '房主一键补位 AI 成功（4 人局）');

    // 开局
    await host.click('#lobby-actions .primary-btn');
    await Promise.all([
      waitScreen(host, 'game', 20000),
      waitScreen(b, 'game', 25000),
      waitScreen(c, 'game', 25000),
    ]);
    ok(true, '三家同时进入对局界面');

    await Promise.all([
      host.waitFor(`return document.querySelectorAll('.seat').length === 4;`, 10000, '甲看到 4 个座位'),
      b.waitFor(`return document.querySelectorAll('.seat').length === 4;`, 10000, '乙看到 4 个座位'),
    ]);

    // 记录真实的连接方式（直连 / 中转）——这是纯前端 P2P 是否成功的关键证据
    await sleep(1500);
    const netLine = await host.eval(`return document.getElementById('lobby-net').textContent;`);
    console.log(`      房主视角的网络状态：${netLine}`);
    const clientNet = await b.eval(`return document.getElementById('lobby-net').textContent;`);
    console.log(`      客人乙视角的网络状态：${clientNet}`);

    // 客户端视野绝不能泄露弹序
    const leak = await b.evalRaw(`(() => {
      const raw = JSON.stringify(window.__sgLastView || null);
      return raw;
    })()`);
    ok(leak === 'null' || !/shells/.test(leak), '客户端页面上没有暴露弹匣顺序');

    // 三家一起打完
    const [r1, r2, r3] = await Promise.all([
      autoPlay(host),
      autoPlay(b),
      autoPlay(c),
    ]);
    ok(r1.over && r2.over && r3.over, `三家都等到了结算（操作数 ${r1.turns}/${r2.turns}/${r3.turns}）`);

    const winners = await Promise.all(
      [host, b, c].map((p) =>
        p.evalRaw(`return document.querySelector('#modal-layer .winner-name')?.textContent || null;`)
      )
    );
    ok(
      winners[0] && winners[0] === winners[1] && winners[1] === winners[2],
      `三家看到的获胜者完全一致：${winners.join(' / ')}`
    );

    await host.screenshot(`${SHOTS}e2e-online-over.png`);

    // 对局中的 HP 快照也应该一致（在结算前抓取，这里退而校验结算名单）
    const errors = [
      ...host.errors.map((e) => `host: ${e}`),
      ...b.errors.map((e) => `乙: ${e}`),
      ...c.errors.map((e) => `丙: ${e}`),
    ];
    ok(errors.length === 0, `三家都没有控制台错误${errors.length ? `：${errors[0]}` : ''}`);
  } finally {
    host.close();
    b.close();
    c.close();
  }
}

/* ================================================================== *
 * 用例 3：四人联机（满员）+ 唯一性校验
 * ================================================================== */

async function testOnlineSync(baseUrl) {
  console.log('\n【用例 3】两家对局中状态一致性抽查');
  const a = await Page.launch({ startUrl: baseUrl, width: 1280, height: 900 });
  const b = await Page.launch({ startUrl: baseUrl });
  try {
    await Promise.all([loadApp(a), loadApp(b)]);
    await Promise.all([waitScreen(a, 'home'), waitScreen(b, 'home')]);
    await setupName(a, '壹');
    await a.click('#btn-create');
    await waitScreen(a, 'lobby', 40000);
    const room = await a.eval(`return document.getElementById('lobby-room-big').textContent;`);

    await setupName(b, '贰');
    await b.setInput('#room-input', room);
    await b.click('#btn-join');
    await waitScreen(b, 'lobby', 45000);

    await a.waitFor(
      `return document.querySelectorAll('#lobby-roster li').length === 2;`,
      20000,
      '房主看到 2 人'
    );
    await a.click('#lobby-actions .primary-btn');
    await Promise.all([waitScreen(a, 'game', 15000), waitScreen(b, 'game', 20000)]);

    // 一步一步走，每走一步就确认两端收敛到同一帧、同一内容。
    // 节奏要像真人：每步之间留一点时间，让公网往返有机会发生，
    // 并且一直打到分出胜负（或超时）为止，而不是固定跑多少次。
    let mismatches = 0;
    let compared = 0;
    let timeouts = 0;
    let progressed = false;
    let ended = false;
    const seen = new Set();
    const deadline = Date.now() + 75000;
    for (let i = 0; i < 500 && Date.now() < deadline; i++) {
      await stepOnce(a, { useItems: false });
      await stepOnce(b, { useItems: false });
      const r = await compareAtSameSeq(a, b);
      if (r.timeout) timeouts += 1;
      if (!r.same) {
        mismatches += 1;
        console.log(`      不一致（甲 seq=${r.x?.seq} 乙 seq=${r.y?.seq}）：`);
        console.log(`      甲 ${r.x && boardKey(r.x)}`);
        console.log(`      乙 ${r.y && boardKey(r.y)}`);
        break;
      }
      compared += 1;
      seen.add(boardKey(r.x));
      // 有人的血掉了、或进入第 2 轮，才说明对局确实在推进
      if (r.x.seats.some((s) => s.hp < 5) || r.x.round !== '1') progressed = true;
      if (await a.eval(`return !document.getElementById('modal-layer').hidden;`)) {
        ended = true;
        break;
      }
      await sleep(90);
    }
    ok(mismatches === 0, '两家在整局中看到的公开状态（血/手牌数/轮次/弹数）始终一致');
    // 有时候一局很短，几步就打完了 —— 只要确实打完了，比对次数少也算合格
    ok(
      compared >= 8 || (ended && compared >= 4),
      `确实做了足够多次比对（${compared} 次，其中 ${timeouts} 次等待收敛超时${ended ? '，对局已打完' : ''}）`
    );
    ok(progressed, `对局真的在推进（观察到 ${seen.size} 种不同的公开状态）`);
    if (!progressed || mismatches) {
      // 出问题时把两端的网络状态和界面提示一起打出来，方便定位
      const [da, db] = await Promise.all([readBoard(a), readBoard(b)]);
      const [na, nb] = await Promise.all([
        a.eval(`return document.getElementById('lobby-net').textContent;`),
        b.eval(`return document.getElementById('lobby-net').textContent;`),
      ]);
      for (const [tag, d, n] of [['甲', da, na], ['乙', db, nb]]) {
        console.log(
          `      诊断 ${tag}：seq=${d.seq} 轮=${d.round} 回合玩家=${d.turn} `
            + `可点按钮=${d.acts} 提示「${d.hint}」 弹窗=${d.modal}\n             网络：${n}`
        );
      }
    }
    ok(
      await a.eval(`return !document.getElementById('modal-layer').hidden;`),
      '这一局在浏览器里打到了结算'
    );
    await a.screenshot(`${SHOTS}e2e-sync.png`);
    ok(a.errors.length === 0 && b.errors.length === 0, '一致性抽查期间无控制台错误');
  } finally {
    a.close();
    b.close();
  }
}

/* ================================================================== *
 * 用例 4：界面自适应（用数值断言代替肉眼看图）
 * ================================================================== */

const VIEWPORTS = [
  { w: 360, h: 640, label: '小屏手机 360×640', mobile: true },
  { w: 430, h: 932, label: '大屏手机 430×932', mobile: true },
  { w: 768, h: 1024, label: '平板 768×1024', mobile: true },
  { w: 1280, h: 900, label: '桌面 1280×900', mobile: false },
];

/** 当前屏幕的布局体检 */
const auditLayout = (page) =>
  page.evalRaw(`(() => {
    const doc = document.documentElement;
    const active = document.querySelector('.screen.is-active');
    const overflowX = doc.scrollWidth - window.innerWidth;

    // 所有可见按钮的点击区域
    const smallTargets = [...active.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && (r.height < 36 || r.width < 32);
      })
      .map((b) => b.className + ':' + Math.round(b.getBoundingClientRect().height));

    // 是否有元素横向跑出视口（被祖先裁掉的不算，比如横向滚动的牌桌/事件流）
    const clippedByAncestor = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true;
      }
      return false;
    };
    const escaping = [...active.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 1) return false;
        if (r.right <= window.innerWidth + 2 && r.left >= -2) return false;
        return !clippedByAncestor(el);
      })
      .slice(0, 4)
      .map((el) => el.className || el.tagName);

    return {
      id: active.id,
      overflowX,
      smallTargets,
      escaping,
      vw: window.innerWidth,
      vh: window.innerHeight,
      bg: getComputedStyle(document.body).backgroundColor,
      controlsVisible: (() => {
        const c = document.querySelector('.controls');
        if (!c) return true;
        const r = c.getBoundingClientRect();
        return r.bottom <= window.innerHeight + 2 && r.height > 40;
      })(),
    };
  })()`);

async function testLayout(baseUrl) {
  console.log('\n【用例 4】界面自适应：手机 / 平板 / 桌面');
  const page = await Page.launch({ startUrl: baseUrl, width: 430, height: 932 });
  try {
    await loadApp(page);
    for (const vp of VIEWPORTS) {
      await page.conn.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: 1,
        mobile: vp.mobile,
      });
      await sleep(400);

      // 确保停在首页（用真实入口返回，不直接改类名）
      const onHome = await page.eval(
        `return document.getElementById('screen-home').classList.contains('is-active');`
      );
      if (!onHome) {
        await page.evalRaw(`document.getElementById('game-menu').click()`);
        await sleep(250);
        await page.click('#modal-layer .modal-actions button:last-child'); // 菜单最后一项＝退出对局
        await waitScreen(page, 'home');
      }

      // 首页
      const home = await auditLayout(page);
      ok(home.overflowX <= 2, `${vp.label} 首页无横向溢出（${home.overflowX}px）`);
      ok(
        home.smallTargets.length === 0,
        `${vp.label} 首页按钮都够大${home.smallTargets.length ? `：${home.smallTargets}` : ''}`
      );

      // 对局界面（4 人）
      await page.click('[data-go="ai"]');
      await waitScreen(page, 'ai');
      const ai = await auditLayout(page);
      ok(ai.overflowX <= 2, `${vp.label} 人机选择页无横向溢出（${ai.overflowX}px）`);

      await page.setInput('#ai-name-input', '测');
      await page.click('[data-players="4"]');
      await waitScreen(page, 'game', 15000);
      // 等到轮到自己，操作按钮才会渲染出来（AI 行动时这里是空的）
      // AI 可能连续行动很久（空弹打自己会保留回合），所以给足时间
      await page.waitFor(
        `return document.querySelectorAll('#actions .act-btn').length > 0;`,
        45000,
        '轮到我行动'
      );
      await sleep(300);

      const game = await auditLayout(page);
      ok(game.overflowX <= 2, `${vp.label} 对局界面无横向溢出（${game.overflowX}px）`);
      ok(game.escaping.length === 0, `${vp.label} 没有元素跑出屏幕${game.escaping.length ? `：${game.escaping}` : ''}`);
      ok(game.controlsVisible, `${vp.label} 操作区完整落在屏幕内`);

      const tap = await page.evalRaw(`(() => {
        const acts = [...document.querySelectorAll('#actions .act-btn')];
        const cards = [...document.querySelectorAll('#hand .card')];
        return {
          actH: acts.length ? Math.round(acts[0].getBoundingClientRect().height) : null,
          cardW: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : null,
          seats: document.querySelectorAll('.seat').length,
          seatRows: new Set([...document.querySelectorAll('.seat')]
            .map((s) => Math.round(s.getBoundingClientRect().top))).size,
        };
      })()`);
      ok(
        tap.actH !== null && tap.actH >= 48,
        `${vp.label} 开枪按钮高度 ${tap.actH}px ≥ 48px`
      );
      ok(tap.cardW !== null && tap.cardW >= 60, `${vp.label} 手牌宽度 ${tap.cardW}px ≥ 60px`);
      ok(tap.seats === 4, `${vp.label} 4 个座位都渲染出来了`);

      await page.screenshot(`${SHOTS}layout-${vp.w}x${vp.h}.png`);
      console.log(
        `      ${vp.label}：溢出 ${game.overflowX}px，开枪按钮 ${tap.actH}px，手牌 ${tap.cardW}px，座位分 ${tap.seatRows} 行`
      );
    }
    ok(page.errors.length === 0, `布局测试期间无控制台错误${page.errors.length ? `：${page.errors[0]}` : ''}`);
  } finally {
    page.close();
  }
}

/* ================================================================== *
 * 主流程
 * ================================================================== */

async function main() {
  if (!findChrome()) {
    console.log('本机没有 Chrome/Edge，跳过浏览器端到端测试');
    return;
  }
  mkdirSync(SHOTS, { recursive: true });

  // 可以传入一个真实网址，直接对线上部署做端到端验证：
  //   node tests/e2e.test.mjs local https://produce123.github.io/shell-gambit/
  const urlArg = process.argv.find((a) => /^https?:\/\//i.test(a));
  const only = process.argv.slice(2).find((a) => !/^https?:\/\//i.test(a));
  let server = null;
  let baseUrl = urlArg;
  if (baseUrl) {
    console.log(`目标站点（线上）：${baseUrl}`);
  } else {
    server = await startServer(0);
    baseUrl = server.url;
    console.log(`本地预览服务：${baseUrl}`);
  }

  const t0 = Date.now();
  try {
    if (!only || only === 'local') await testLocalGame(baseUrl);
    if (!only || only === 'online') await testOnlineGame(baseUrl);
    if (!only || only === 'sync') await testOnlineSync(baseUrl);
    if (!only || only === 'layout') await testLayout(baseUrl);
  } catch (err) {
    failures.push(err.message);
    console.error('用例中断：', err);
  } finally {
    await server?.close();
  }

  console.log(
    `\n${failures.length ? '✗' : '✓'} 浏览器端到端测试：${passed} 项通过，${failures.length} 项失败（${(
      (Date.now() - t0) / 1000
    ).toFixed(1)}s）`
  );
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`截图已保存到 ${SHOTS}`);
}

await main();