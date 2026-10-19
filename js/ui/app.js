/**
 * Shell Gambit — 界面主控
 *
 * 负责：屏幕切换、名字录入、房间大厅、对局渲染、事件动画播放。
 *
 * 一个重要原则：**UI 只渲染引擎给出的合法动作**（view.me.legal）。
 * 因此界面上永远不可能出现一个引擎会拒绝的按钮，双端规则也永远一致。
 */

import { ALL_ITEMS, ITEM_INFO, MAX_HP } from '../engine/constants.js';
import {
  ClientSession,
  HostSession,
  LocalSession,
  isValidName,
} from '../net/session.js';
import {
  ROOM_CODE_LENGTH,
  makePeerId,
  makeRoomCode,
  normalizeRoomCode,
} from '../net/protocol.js';
import { bindClickSounds, sfx } from './audio.js';
import {
  banner,
  burst,
  damageNumber,
  flyProjectile,
  hideModal,
  muzzleFlash,
  shakeApp,
  showModal,
  toast,
} from './effects.js';
import { colorIndex, icon } from './icons.js';

/* ------------------------------------------------------------------ *
 * 全局状态
 * ------------------------------------------------------------------ */

const state = {
  name: localStorage.getItem('sg.name') || '',
  session: null,
  role: null, // host | client | local
  view: null,
  lastEventN: 0,
  targetingItem: null,
  myId: null,
  busy: false,
  overShown: false,
  seatEls: new Map(),
  lobbyEls: new Map(),
};

const $ = (id) => document.getElementById(id);

/** 单字名字池（随机按钮用） */
const NAME_POOL =
  '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥风雨雷电云雾霜雪花叶星辰山海江河'.split('');

const randomName = () => NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];

/** 渲染 HTML 前先转义：名字来自网络，不能当成标记直接插进页面 */
const escapeHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/* ------------------------------------------------------------------ *
 * 屏幕切换
 * ------------------------------------------------------------------ */

function show(id) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('is-active', s.id === `screen-${id}`);
  }
}

/** 离开当前对局/房间，回到干净状态 */
function leaveSession(reason) {
  if (state.session) {
    try {
      state.session.close();
    } catch {
      /* 忽略 */
    }
  }
  state.session = null;
  state.role = null;
  state.view = null;
  state.myId = null;
  state.busy = false;
  state.overShown = false;
  state.lastEventN = 0;
  state.targetingItem = null;
  state.seatEls.clear();
  state.lobbyEls.clear();
  if (reason) toast(reason);
}

/* ------------------------------------------------------------------ *
 * 名字（必须是单字）
 * ------------------------------------------------------------------ */

function setAvatar(el, name) {
  if (!el) return;
  el.textContent = name || '?';
  el.dataset.color = String(colorIndex(name || '?'));
}

function updateNameUI() {
  const ok = isValidName(state.name);
  $('name-confirm').disabled = !ok;
  setAvatar($('name-avatar'), state.name);
  setAvatar($('online-avatar'), state.name);
  setAvatar($('ai-avatar'), state.name);
  $('online-name').textContent = ok ? state.name : '未设置名字';
  if ($('ai-name-input').value !== state.name) $('ai-name-input').value = state.name;
  if ($('name-input').value !== state.name) $('name-input').value = state.name;
}

/** 单字输入：只保留 1 个字符（按码点算，emoji 也算一个） */
function onNameInput(e) {
  const v = [...e.target.value].slice(0, 1).join('');
  if (e.target.value !== v) e.target.value = v;
  state.name = v;
  localStorage.setItem('sg.name', v);
  updateNameUI();
}

function pickName(v) {
  state.name = v;
  localStorage.setItem('sg.name', v);
  updateNameUI();
}

/* ------------------------------------------------------------------ *
 * 导航
 * ------------------------------------------------------------------ */

function bindNavigation() {
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      sfx.ensure();
      const target = go.dataset.go;
      // 联机前必须先有单字名字
      if (target === 'online' && !isValidName(state.name)) {
        updateNameUI();
        show('name');
        toast('先取一个单字名字吧');
        return;
      }
      if (target === 'ai' || target === 'name') updateNameUI();
      show(target);
      return;
    }
    const back = e.target.closest('[data-back]');
    if (back) {
      sfx.ensure();
      show(back.dataset.back);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 人机对局
 * ------------------------------------------------------------------ */

function startLocalGame(playerCount) {
  if (!isValidName(state.name)) {
    toast('请先设置一个单字名字', 'error');
    $('ai-name-input').focus();
    return;
  }
  leaveSession();
  state.myId = `me-${makePeerId()}`;
  state.role = 'local';
  const session = new LocalSession({
    player: { id: state.myId, name: state.name },
    aiCount: playerCount - 1,
  });
  state.session = session;
  wireSession(session);
  show('game');
  $('lobby-net').textContent = '单机人机对局 · 不联网';
  session.start();
}

function bindAiScreen() {
  $('ai-counts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-players]');
    if (!btn) return;
    sfx.ensure();
    startLocalGame(Number(btn.dataset.players));
  });
  $('ai-name-input').addEventListener('input', onNameInput);
  $('ai-name-random').addEventListener('click', () => {
    sfx.ensure();
    pickName(randomName());
  });
}

/* ------------------------------------------------------------------ *
 * 在线对局：名字 / 建房 / 加入
 * ------------------------------------------------------------------ */

function requireName() {
  if (isValidName(state.name)) return true;
  toast('请先设置一个单字名字', 'error');
  updateNameUI();
  show('name');
  return false;
}

function bindNameScreen() {
  $('name-input').addEventListener('input', onNameInput);
  $('name-random').addEventListener('click', () => {
    sfx.ensure();
    pickName(randomName());
  });

  // 常用字快捷选择
  const suggest = $('name-suggest');
  const picks = [];
  while (picks.length < 10) {
    const c = randomName();
    if (!picks.includes(c)) picks.push(c);
  }
  for (const c of picks) {
    const b = document.createElement('button');
    b.textContent = c;
    b.addEventListener('click', () => {
      sfx.ensure();
      pickName(c);
    });
    suggest.appendChild(b);
  }

  $('name-confirm').addEventListener('click', () => {
    sfx.ensure();
    if (!isValidName(state.name)) return;
    show('online');
  });
}

function bindOnlineScreen() {
  const roomInput = $('room-input');
  const joinBtn = $('btn-join');

  const syncJoin = () => {
    const code = normalizeRoomCode(roomInput.value);
    if (roomInput.value !== code) roomInput.value = code;
    joinBtn.disabled = code.length !== ROOM_CODE_LENGTH;
  };
  roomInput.addEventListener('input', syncJoin);
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
  });

  $('btn-create').addEventListener('click', () => {
    sfx.ensure();
    if (requireName()) hostRoom();
  });
  joinBtn.addEventListener('click', () => {
    sfx.ensure();
    if (requireName()) joinRoom(normalizeRoomCode(roomInput.value));
  });
}

async function hostRoom() {
  leaveSession();
  state.role = 'host';
  state.myId = `h-${makePeerId()}`;
  const session = new HostSession({
    room: makeRoomCode(),
    player: { id: state.myId, name: state.name },
  });
  state.session = session;
  wireSession(session);
  const status = $('online-status');
  status.textContent = '正在连接公共信令通道…';
  try {
    await session.open();
    status.textContent = '';
    enterLobby();
  } catch (err) {
    status.textContent = '';
    leaveSession(err.message || '建房失败');
  }
}

async function joinRoom(roomCode) {
  leaveSession();
  state.role = 'client';
  state.myId = `c-${makePeerId()}`;
  const session = new ClientSession({
    room: roomCode,
    player: { id: state.myId, name: state.name },
  });
  state.session = session;
  wireSession(session);
  const status = $('online-status');
  status.textContent = `正在寻找房间 ${roomCode}…`;
  try {
    await session.open();
    status.textContent = '';
    enterLobby();
  } catch (err) {
    status.textContent = '';
    leaveSession(err.message || '加入失败');
  }
}

function enterLobby() {
  const s = state.session;
  $('lobby-room').textContent = s.room;
  $('lobby-room-big').textContent = s.room;
  show('lobby');
  const payload = s.lobbyState
    ? s.lobbyState()
    : { participants: s.participants || [], isHost: false };
  renderLobby(payload);
}

/* ------------------------------------------------------------------ *
 * 会话事件接线
 * ------------------------------------------------------------------ */

function wireSession(session) {
  session.on('lobby', (payload) => renderLobby(payload));

  session.on('start', () => {
    state.overShown = false;
    state.lastEventN = 0;
    state.view = null;
    state.targetingItem = null;
    state.busy = false;
    state.seatEls.clear();
    state.lobbyEls.clear();
    $('seats').innerHTML = '';
    $('feed').innerHTML = '';
    $('hud-known')?.remove();
    hideModal();
    show('game');
  });

  session.on('state', (view) => renderGame(view));

  session.on('over', (payload) => {
    if (state.overShown) return;
    state.overShown = true;
    state.busy = false;
    showResult(payload);
  });

  session.on('reaction', (r) => playReaction(r));
  session.on('toast', (msg) => toast(msg));
  session.on('net', (st) => renderNetLine(st));

  session.on('pending', (p) => {
    state.busy = !!p;
    if (state.view) renderGame(state.view);
  });

  session.on('closed', (reason) => {
    leaveSession();
    show('online');
    toast(reason || '连接已断开', 'error');
  });
}

/* ------------------------------------------------------------------ *
 * 互动：扔鸡蛋 / 送鲜花
 * ------------------------------------------------------------------ */

/** 单选一个目标时用：点头像直接弹这个小面板 */
function openReactionPicker(targetId, targetName) {
  sfx.ensure();
  showModal({
    title: `对 ${targetName}`,
    body: '选一个动作',
    actions: [
      {
        label: '🥚 扔鸡蛋',
        primary: true,
        onClick: () => sendReaction('egg', targetId),
      },
      { label: '🌸 送鲜花', onClick: () => sendReaction('flower', targetId) },
      { label: '取消', onClick: () => {} },
    ],
  });
}

/** 对局中随时可以互动（不占用回合，不影响出牌） */
function openGameReactPanel() {
  sfx.ensure();
  const players = state.view?.players || state.participants || [];
  const others = players.filter((p) => p.id !== state.myId);
  if (!others.length) {
    toast('还没有其他玩家');
    return;
  }
  const html = `<div class="react-grid">${others
    .map(
      (p) => `<div class="react-row">
        <div class="avatar" data-color="${colorIndex(p.name)}">${escapeHtml(p.name)}</div>
        <span class="who-name">${escapeHtml(p.name)}</span>
        <button class="throw-btn" data-kind="egg" data-to="${escapeHtml(p.id)}">🥚</button>
        <button class="throw-btn" data-kind="flower" data-to="${escapeHtml(p.id)}">🌸</button>
      </div>`
    )
    .join('')}</div>`;

  showModal({
    title: '互动',
    html,
    actions: [{ label: '关闭', onClick: () => {} }],
    onMount: (box) => {
      for (const btn of box.querySelectorAll('.throw-btn')) {
        btn.addEventListener('click', () => {
          sendReaction(btn.dataset.kind, btn.dataset.to);
          hideModal();
        });
      }
    },
  });
}

function sendReaction(kind, targetId) {
  const s = state.session;
  if (!s || typeof s.react !== 'function') {
    toast('单机模式没有其他真人玩家');
    return;
  }
  s.react(kind, targetId);
}

/* ------------------------------------------------------------------ *
 * 大厅
 * ------------------------------------------------------------------ */

function renderLobby(payload) {
  const list = $('lobby-roster');
  const participants = payload.participants || [];
  const isHost = payload.isHost;
  list.innerHTML = '';
  state.lobbyEls.clear();

  for (const p of participants) {
    const li = document.createElement('li');
    if (p.id === state.myId) li.classList.add('is-me');

    const av = document.createElement('div');
    av.className = 'avatar';
    setAvatar(av, p.name);
    // 点头像即可互动（扔鸡蛋 / 送鲜花）
    if (p.id !== state.myId) {
      av.classList.add('is-clickable');
      av.title = `对 ${p.name} 扔鸡蛋 / 送鲜花`;
      av.addEventListener('click', () => openReactionPicker(p.id, p.name));
    }
    li.appendChild(av);
    state.lobbyEls.set(p.id, av);

    const who = document.createElement('div');
    who.className = 'who';
    const b = document.createElement('b');
    b.textContent = p.name + (p.id === state.myId ? '（我）' : '');
    who.appendChild(b);
    const tag = document.createElement('span');
    tag.className = 'tag';
    if (p.isAi) {
      tag.classList.add('ai');
      tag.textContent = 'AI 对手';
    } else if (p.isHost) {
      tag.classList.add('host');
      tag.textContent = '房主';
    } else {
      tag.textContent = '玩家';
    }
    who.appendChild(tag);
    li.appendChild(who);

    // 扔鸡蛋 / 鲜花（不能扔自己）
    if (p.id !== state.myId) {
      const box = document.createElement('div');
      box.className = 'throw';
      for (const kind of ['egg', 'flower']) {
        const btn = document.createElement('button');
        btn.className = 'throw-btn';
        btn.textContent = kind === 'egg' ? '🥚' : '🌸';
        btn.title = kind === 'egg' ? '扔鸡蛋' : '送鲜花';
        btn.addEventListener('click', () => {
          sfx.ensure();
          sendReaction(kind, p.id);
        });
        box.appendChild(btn);
      }
      li.appendChild(box);
    }

    // 房主可以移除自己补位的 AI
    if (isHost && p.isAi) {
      const rm = document.createElement('button');
      rm.className = 'throw-btn';
      rm.textContent = '✕';
      rm.title = '移除这个 AI';
      rm.addEventListener('click', () => {
        sfx.ensure();
        state.session?.removeAi(p.id);
      });
      li.appendChild(rm);
    }

    list.appendChild(li);
  }

  const actions = $('lobby-actions');
  actions.innerHTML = '';
  if (isHost) {
    if (participants.length < 4) {
      const addAi = document.createElement('button');
      addAi.className = 'ghost-btn';
      addAi.textContent = '＋ 添加 AI 补位';
      addAi.addEventListener('click', () => {
        sfx.ensure();
        state.session.addAi();
      });
      actions.appendChild(addAi);
    }
    const start = document.createElement('button');
    start.className = 'primary-btn';
    start.textContent = `开始对局（${participants.length} 人）`;
    start.disabled = participants.length < 2;
    start.addEventListener('click', () => {
      sfx.ensure();
      if (!state.session.beginGame()) toast('至少需要 2 名参与者', 'error');
    });
    actions.appendChild(start);
  } else {
    const wait = document.createElement('p');
    wait.className = 'hint';
    wait.textContent =
      participants.length >= 2 ? '等待房主开始对局…' : '等待其他玩家加入…';
    actions.appendChild(wait);
  }
}

function renderNetLine(st) {
  const el = $('lobby-net');
  if (!el) return;
  if (state.role === 'local') {
    el.textContent = '单机人机对局 · 不联网';
    return;
  }
  const parts = [];
  if (st.role === 'host') parts.push('你是房主');
  else if (st.hostId) parts.push('已找到房主');
  if (st.linkMode === 'direct') parts.push('P2P 直连');
  else if (st.linkMode === 'relay') parts.push('中转模式');
  const links = st.links ? Object.values(st.links) : [];
  if (links.length) {
    parts.push(`${links.filter((m) => m === 'direct').length}/${links.length} 人已直连`);
  }
  if (st.closed) parts.push('信令已断开（直连不受影响）');
  const channels = (st.channels || []).map(
    (c) => `${c.label}${c.state === 'open' ? '✓' : '✗'}`
  );
  el.textContent = [parts.join(' · '), channels.join(' ')].filter(Boolean).join('　|　');
}

function bindLobby() {
  $('lobby-leave').addEventListener('click', () => {
    sfx.ensure();
    leaveSession('已离开房间');
    show('home');
  });

  $('lobby-copy').addEventListener('click', async () => {
    sfx.ensure();
    const code = state.session?.room || '';
    try {
      await navigator.clipboard.writeText(code);
      toast(`房间号 ${code} 已复制`);
    } catch {
      toast(`房间号：${code}`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 对局渲染
 * ------------------------------------------------------------------ */

function findAvatarEl(pid) {
  return state.seatEls.get(pid)?.querySelector('.avatar') || state.lobbyEls.get(pid) || null;
}

function playReaction(r) {
  const toEl = findAvatarEl(r.targetId);
  if (toEl) flyProjectile(findAvatarEl(r.from), toEl, r.kind);
  else {
    const anySeat = [...state.seatEls.values()][0];
    if (anySeat) burst(anySeat, r.kind);
  }
}

function renderGame(view) {
  if (!view) return;
  state.view = view;
  if (view.me?.id) state.myId = view.me.id;

  const mine = view.me?.id || state.myId;

  // 把状态帧序号挂在 DOM 上：便于调试，也便于自动化测试判断「两端是否真的同步到同一帧」
  $('screen-game').dataset.seq = String(view.seq);

  // --- HUD ---
  $('hud-round').textContent = view.round;
  $('hud-live').textContent = view.magazine.live;
  $('hud-blank').textContent = view.magazine.blank;
  $('hud-saw').hidden = !view.saw;
  renderKnowledgeChip(view);

  renderSeats(view, mine);
  renderHand(view);
  renderActions(view, mine);
  playNewEvents(view);
}

/** 「已知下一发」提示条：只有自己看得到 */
function renderKnowledgeChip(view) {
  let chip = $('hud-known');
  const knows = view.me?.knows;
  if (!knows) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'hud-known';
    chip.className = 'chip';
    document.querySelector('.hud-mag').appendChild(chip);
  }
  chip.className = `chip ${knows === 'live' ? 'chip-live' : 'chip-blank'}`;
  chip.textContent = `已知下一发：${knows === 'live' ? '实弹' : '空弹'}`;
}

function renderSeats(view, mine) {
  const wrap = $('seats');
  const seen = new Set();
  const legal = view.me?.legal || [];

  // 可以点座位来指定的目标（需要二次选目标 / 道具指向目标）
  const pendingTargets = new Set(
    legal.filter((a) => a.type === 'target').map((a) => a.targetId)
  );
  const itemTargets = new Set(
    state.targetingItem
      ? legal
          .filter((a) => a.type === 'use' && a.item === state.targetingItem)
          .map((a) => a.targetId)
      : []
  );

  for (const p of view.players) {
    seen.add(p.id);
    let el = state.seatEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'seat';
      el.innerHTML = `
        <span class="seat-seat"></span>
        <span class="badge" hidden></span>
        <div class="avatar"></div>
        <div class="seat-name"></div>
        <div class="hp"></div>
        <div class="seat-meta"></div>`;
      el.addEventListener('click', () => onSeatClick(p.id));
      wrap.appendChild(el);
      state.seatEls.set(p.id, el);
    }

    el.classList.toggle('is-turn', view.turn === p.id && view.phase === 'playing');
    el.classList.toggle('is-me', p.id === mine);
    el.classList.toggle('is-dead', !p.alive);
    el.classList.toggle(
      'is-targetable',
      p.alive && p.id !== mine && (pendingTargets.has(p.id) || itemTargets.has(p.id))
    );

    el.querySelector('.seat-seat').textContent = `${p.seat} 号`;
    const av = el.querySelector('.avatar');
    if (av.textContent !== p.name) setAvatar(av, p.name);
    el.querySelector('.seat-name').textContent = p.id === mine ? `${p.name}（我）` : p.name;

    const hp = el.querySelector('.hp');
    if (hp.children.length !== MAX_HP) {
      hp.innerHTML = '';
      for (let i = 0; i < MAX_HP; i++) hp.appendChild(document.createElement('i'));
    }
    [...hp.children].forEach((pip, i) => pip.classList.toggle('off', i >= p.hp));

    el.querySelector('.seat-meta').textContent = `🂠 ${p.handCount}`;

    const badge = el.querySelector('.badge');
    if (p.cuffed) {
      badge.hidden = false;
      badge.className = 'badge cuffed';
      badge.textContent = '手铐';
    } else if (!p.alive) {
      badge.hidden = false;
      badge.className = 'badge';
      badge.textContent = '出局';
    } else {
      badge.hidden = true;
    }
  }

  for (const [id, el] of [...state.seatEls]) {
    if (!seen.has(id)) {
      el.remove();
      state.seatEls.delete(id);
    }
  }
}

function onSeatClick(pid) {
  const view = state.view;
  if (!view || state.busy) return;
  const legal = view.me?.legal || [];

  const pending = legal.find((a) => a.type === 'target' && a.targetId === pid);
  if (pending) return doAction({ type: 'target', targetId: pid });

  if (state.targetingItem) {
    const use = legal.find(
      (a) => a.type === 'use' && a.item === state.targetingItem && a.targetId === pid
    );
    if (use) {
      state.targetingItem = null;
      return doAction({ type: 'use', item: use.item, targetId: pid });
    }
  }
}

function renderHand(view) {
  const box = $('hand');
  const hand = view.me?.hand || [];
  const legal = view.me?.legal || [];
  box.innerHTML = '';

  if (!hand.length) {
    const p = document.createElement('div');
    p.className = 'hand-empty';
    p.textContent = view.me?.alive === false ? '你已出局' : '没有手牌';
    box.appendChild(p);
    return;
  }

  for (const item of hand) {
    const info = ITEM_INFO[item];
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.innerHTML = `${icon(info.icon)}<span>${info.name}</span>`;
    btn.disabled = !legal.some((a) => a.type === 'use' && a.item === item) || state.busy;
    btn.classList.toggle('is-picked', state.targetingItem === item);
    btn.addEventListener('click', () => onCardClick(item));
    box.appendChild(btn);
  }
}

function onCardClick(item) {
  sfx.ensure();
  const view = state.view;
  if (!view || state.busy) return;
  const legal = view.me?.legal || [];
  if (!legal.some((a) => a.type === 'use' && a.item === item)) return;

  if (ITEM_INFO[item].needsTarget) {
    // 需要选目标：进入选择模式（再点一次取消）
    state.targetingItem = state.targetingItem === item ? null : item;
    if (state.targetingItem) toast(`选择「${ITEM_INFO[item].name}」的目标`);
    renderGame(view);
    return;
  }
  doAction({ type: 'use', item });
}

function renderActions(view, mine) {
  const box = $('actions');
  box.innerHTML = '';
  const hint = $('turn-hint');
  const me = view.me;

  if (view.phase === 'over') {
    hint.textContent = '本局结束';
    hint.classList.remove('is-mine');
    return;
  }
  if (!me || !me.alive) {
    hint.textContent = '你已出局，观战中';
    hint.classList.remove('is-mine');
    return;
  }
  if (view.turn !== mine) {
    const cur = view.players.find((p) => p.id === view.turn);
    hint.textContent = `等待 ${cur?.name || '对手'} 行动…`;
    hint.classList.remove('is-mine');
    return;
  }

  hint.classList.add('is-mine');
  if (state.busy) {
    hint.textContent = '等待房主确认…';
    return;
  }

  const legal = me.legal || [];

  // ① 需要二次指定目标（肾上腺素偷到手铐）
  const pendingTargets = legal.filter((a) => a.type === 'target');
  if (pendingTargets.length) {
    hint.textContent = '偷到了手铐，选择要锁住的人';
    for (const a of pendingTargets) {
      const p = view.players.find((x) => x.id === a.targetId);
      box.appendChild(
        makeActBtn(`🔒 锁住 ${p?.name || '?'}`, 'act-btn shoot', () => doAction(a))
      );
    }
    return;
  }

  // ② 道具选目标模式
  if (state.targetingItem) {
    hint.textContent = `选择「${ITEM_INFO[state.targetingItem].name}」的目标`;
    for (const a of legal.filter((x) => x.type === 'use' && x.item === state.targetingItem)) {
      const p = view.players.find((x) => x.id === a.targetId);
      box.appendChild(
        makeActBtn(`→ ${p?.name || '?'}`, 'act-btn shoot', () => {
          state.targetingItem = null;
          doAction(a);
        })
      );
    }
    box.appendChild(
      makeActBtn('取消', 'act-btn cancel', () => {
        state.targetingItem = null;
        renderGame(view);
      })
    );
    return;
  }

  // ③ 正常回合：对自己开枪 + 打别人（都由引擎的 legal 驱动）
  const shoots = legal.filter((a) => a.type === 'shoot');
  const selfShot = shoots.find((a) => a.targetId === mine);
  if (selfShot) {
    const known = me.knows;
    const label =
      known === 'blank'
        ? '对自己开枪（已知空弹）'
        : known === 'live'
          ? '对自己开枪（已知实弹！）'
          : '对自己开枪';
    box.appendChild(makeActBtn(label, 'act-btn self', () => doAction(selfShot)));
  }
  for (const a of shoots) {
    if (a.targetId === mine) continue;
    const p = view.players.find((x) => x.id === a.targetId);
    box.appendChild(makeActBtn(`打 ${p?.name || '?'}`, 'act-btn shoot', () => doAction(a)));
  }

  hint.textContent = me.hand.length ? '也可以先用手牌' : '没有手牌，直接开枪';
}

function makeActBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', () => {
    sfx.ensure();
    onClick();
  });
  return b;
}

/** 统一的动作提交入口 */
function doAction(action) {
  const session = state.session;
  if (!session) return;
  if (state.role === 'client') {
    const res = session.submit(action);
    if (!res.ok) {
      toast(res.error || '操作失败', 'error');
      return;
    }
    state.busy = true;
    if (state.view) renderGame(state.view);
    return;
  }
  const res = session.submitLocal
    ? session.submitLocal(action)
    : session.submit(action);
  if (res && !res.ok && res.error) toast(res.error, 'error');
}

/* ------------------------------------------------------------------ *
 * 事件动画：把引擎日志变成看得见的动作
 * ------------------------------------------------------------------ */

function playNewEvents(view) {
  const log = view.log || [];
  if (!log.length) return;
  for (const e of log) {
    if (e.n > state.lastEventN) handleEvent(e, view);
  }
  state.lastEventN = log[log.length - 1].n;
}

function feedAdd(text, cls) {
  const feed = $('feed');
  if (!feed) return;
  const el = document.createElement('div');
  el.className = `feed-item${cls ? ` ${cls}` : ''}`;
  el.textContent = text;
  feed.appendChild(el);
  while (feed.children.length > 4) feed.firstElementChild.remove();
}

const nameOf = (view, id) => view.players.find((p) => p.id === id)?.name || '?';
const shellName = (s) => (s === 'live' ? '实弹' : '空弹');

function handleEvent(e, view) {
  switch (e.t) {
    case 'round': {
      sfx.play('round');
      banner(`第 ${e.round} 轮`, 'var(--gold)');
      feedAdd(`第 ${e.round} 轮 · 实弹 ${e.live} / 空弹 ${e.blank}`, 'item');
      break;
    }
    case 'turn': {
      if (e.drew > 0) feedAdd(`${nameOf(view, e.player)} 摸了 ${e.drew} 张牌`);
      break;
    }
    case 'recycle':
      feedAdd(`弃牌堆回收重洗（${e.count} 张）`);
      break;
    case 'use': {
      const label = ITEM_INFO[e.item]?.name || e.item;
      sfx.play(sfxForItem(e.item));
      banner(label, 'var(--gold)');
      let extra = e.target ? ` → ${nameOf(view, e.target)}` : '';
      if (e.item === 'beer') extra = ` · 退出一发${shellName(e.ejected)}`;
      if (e.item === 'cigarette' && !e.healed) extra = ' · 满血浪费了';
      if (e.item === 'adrenaline') {
        extra = e.stolen
          ? ` → 偷到 ${ITEM_INFO[e.stolen]?.name || e.stolen}${e.wasted ? '（无合法目标，浪费）' : ''}`
          : ' → 对方没有手牌';
      }
      feedAdd(`${nameOf(view, e.player)} 使用 ${label}${extra}`, 'item');

      if (e.item === 'magnifier' && e.player === state.myId && view.me?.knows) {
        toast(
          `放大镜：下一发是${shellName(view.me.knows)}`,
          view.me.knows === 'live' ? 'error' : ''
        );
      }
      if (e.item === 'handcuffs' && e.target) {
        toast(`${nameOf(view, e.target)} 被戴上铐`);
      }
      break;
    }
    case 'shoot': {
      const shooter = findAvatarEl(e.player);
      const target = findAvatarEl(e.target);
      const who = `${nameOf(view, e.player)} ${
        e.self ? '对自己' : `对 ${nameOf(view, e.target)}`
      } 开枪`;
      if (e.shell === 'live') {
        sfx.play('shoot');
        muzzleFlash(shooter);
        shakeApp();
        if (target) {
          const seat = target.closest('.seat');
          seat?.classList.add('is-hit');
          setTimeout(() => seat?.classList.remove('is-hit'), 460);
          damageNumber(target, `-${e.damage}`);
        }
        banner(e.self ? '砰！自己中弹' : '砰！实弹命中', 'var(--live)');
        feedAdd(`${who} · 实弹 -${e.damage}${e.saw ? '（锯短枪管）' : ''}`, 'live');
      } else {
        sfx.play('blank');
        banner('咔！空弹', 'var(--blank)');
        feedAdd(`${who} · 空弹`, 'blank');
      }
      break;
    }
    case 'elim': {
      sfx.play('hurt');
      banner(`${nameOf(view, e.player)} 出局`, 'var(--text-dim)');
      feedAdd(`${nameOf(view, e.player)} 被淘汰`, 'live');
      break;
    }
    case 'skip': {
      sfx.play('cuff');
      banner(`${nameOf(view, e.player)} 被锁住`, 'var(--gold)');
      feedAdd(`${nameOf(view, e.player)} 被手铐跳过回合`, 'item');
      break;
    }
    case 'over': {
      sfx.play(e.winner === state.myId ? 'win' : 'lose');
      break;
    }
    default:
      break;
  }
}

function sfxForItem(item) {
  switch (item) {
    case 'magnifier':
      return 'info';
    case 'inverter':
      return 'invert';
    case 'handsaw':
      return 'saw';
    case 'cigarette':
      return 'heal';
    case 'handcuffs':
      return 'cuff';
    default:
      return 'card';
  }
}

/* ------------------------------------------------------------------ *
 * 结算
 * ------------------------------------------------------------------ */

function showResult(payload) {
  const winner = payload.players?.find((p) => p.id === payload.winner);
  const iWon = payload.winner === state.myId;
  const actions = [];

  if (state.role === 'client') {
    actions.push({
      label: '请求再来一局',
      primary: true,
      onClick: () => {
        state.session?.requestRematch();
        toast('已告诉房主你想再来一局');
      },
    });
  } else {
    actions.push({
      label: '再来一局',
      primary: true,
      onClick: () => state.session?.requestRematch(),
    });
  }
  actions.push({
    label: '返回首页',
    onClick: () => {
      leaveSession();
      show('home');
    },
  });

  showModal({
    title: iWon ? '你活到了最后' : '对局结束',
    body: `<div class="winner-name">${escapeHtml(winner?.name || '无人')}</div><p>${
      iWon ? '恭喜获胜！' : `${escapeHtml(winner?.name || '?')} 是最后的幸存者`
    }</p>`,
    actions,
  });
}

/* ------------------------------------------------------------------ *
 * 游戏内菜单
 * ------------------------------------------------------------------ */

function bindGameMenu() {
  $('game-react').addEventListener('click', () => openGameReactPanel());

  $('game-menu').addEventListener('click', () => {
    sfx.ensure();
    const role =
      state.role === 'host' ? '你是房主' : state.role === 'client' ? '你是客人' : '人机对局';
    showModal({
      title: '菜单',
      body: `<p>房间：${state.session?.room || '单机'}<br />${role}</p>`,
      actions: [
        { label: '继续游戏', primary: true, onClick: () => {} },
        {
          label: '退出对局',
          onClick: () => {
            leaveSession('已退出对局');
            show('home');
          },
        },
      ],
    });
  });
}

/* ------------------------------------------------------------------ *
 * 规则页
 * ------------------------------------------------------------------ */

function renderRules() {
  const items = ALL_ITEMS.map(
    (id) => `
    <div class="item-row">${icon(ITEM_INFO[id].icon)}
      <div><b>${ITEM_INFO[id].name}</b><br />${ITEM_INFO[id].desc}</div>
    </div>`
  ).join('');

  $('rules-body').innerHTML = `
    <h3>基础玩法</h3>
    <ul>
      <li>2–4 人，每人 <b>5 点生命</b>，开局随机分配 1–4 号座位。</li>
      <li>每<b>轮</b>随机装填一批「实弹 / 空弹」混合弹序，<b>两种弹药各剩多少是公开的，先后顺序保密</b>。</li>
      <li>轮到你就摸牌，然后选择【对自己开枪】或【对别人开枪】。</li>
      <li><b>空弹打自己</b>：不掉血，并且<b>保留回合</b>，可以继续操作。</li>
      <li>实弹命中扣 1 点血（锯短枪管时扣 2 点），血量归零立即淘汰。</li>
      <li>弹匣打空后自动重新装填，<b>从 1 号座位开始新一轮</b>（1 号已出局则由下一个存活座位开始）。</li>
      <li>最后活下来的唯一玩家获胜，可以随时再开一局。</li>
    </ul>

    <h3>摸牌规则</h3>
    <ul>
      <li>牌堆共 28 张（每种道具各 4 张）。</li>
      <li>开局每人 2 张；之后每个回合摸 2 张，<b>全局第一回合只摸 1 张</b>。</li>
      <li>手牌上限 4 张：回合开始前有 3 张就只发 1 张，已有 4 张则不发。</li>
      <li>摸牌堆少于 4 张时，弃牌堆重新洗匀后放到摸牌堆<b>底部</b>。</li>
    </ul>

    <h3>道具</h3>
    ${items}

    <h3>几个容易记错的细节</h3>
    <ul>
      <li>放大镜看到的情报<b>只有自己知道</b>，别人看不到。</li>
      <li>逆转器是公开动作：原本知道这一发的人，会同步知道它被反转了。</li>
      <li>手锯只对<b>下一发</b>有效，打出空弹就浪费了；已经锯过不能重复锯。</li>
      <li>香烟回血上限 5 点，满血使用等于浪费一张牌。</li>
      <li>肾上腺素偷不到对手的肾上腺素（防止无限循环）；偷到手铐会再让你选一次目标。</li>
      <li>手铐不能铐自己，也不能铐已经被铐住的人。</li>
    </ul>

    <h3>联机说明</h3>
    <ul>
      <li>服务器：<b>没有</b>。所有人输入相同房间号即可配对。</li>
      <li>对局数据走 <b>WebRTC P2P 直连</b>；网络受限时自动降级为<b>中转模式</b>，照样能玩。</li>
      <li>配对成功后即使信令通道断开，对局也不会中断。</li>
      <li>房主是权威端，其他人只发送操作意图，因此不可能出现同步错乱或作弊。</li>
    </ul>

    <h3>关于 AI</h3>
    <p>AI 与真人看到的信息完全一样：只有公开的血量、手牌张数、剩余弹药数量，
    以及自己用放大镜看到的结果。它<b>读不到弹匣顺序，也读不到别人的手牌</b>，
    更不知道谁是真人谁是 AI，因此不会针对或保护任何人。</p>
  `;
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

export function init() {
  bindClickSounds(document);
  bindNavigation();
  bindAiScreen();
  bindNameScreen();
  bindOnlineScreen();
  bindLobby();
  bindGameMenu();
  renderRules();
  updateNameUI();

  // 手机端首次点击时解锁音频
  document.addEventListener('pointerdown', () => sfx.ensure(), { once: true });
  // 阻止移动端双击缩放
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // 标记初始化完成（自动化测试等待这个标记，避免在事件绑定前点击）
  document.body.dataset.sgReady = '1';
}