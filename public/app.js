// Mastermind frontend: plain DOM, hash routing, no build step.

const PEGS = [
  { name: 'Red', symbol: '●' },
  { name: 'Yellow', symbol: '▲' },
  { name: 'Green', symbol: '■' },
  { name: 'Blue', symbol: '◆' },
  { name: 'White', symbol: '★' },
  { name: 'Purple', symbol: '✚' },
];
const CODE_LENGTH = 4;
const MAX_GUESSES = 10;
const LOSS_SCORE = 11;

const view = document.getElementById('view');
let me = null;
let timerHandle = null;

// --- helpers ---

/** Build an element. Children may be nodes, strings or arrays; text is never parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.hidden = true; }, 3500);
}

function fmtTime(seconds) {
  if (seconds == null) return '–';
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
const fmt1 = (n) => (n == null ? '–' : (Math.round(n * 100) / 100).toLocaleString('en', { maximumFractionDigits: 2 }));
const scoreLabel = (s) => (s >= LOSS_SCORE ? 'Lost' : `${s}`);

function peg(colour, { tag = 'span', size, ...attrs } = {}) {
  const node = el(tag, {
    class: `peg ${colour == null ? 'empty' : `c${colour}`}`,
    ...attrs,
  }, colour == null ? '' : el('span', { 'aria-hidden': 'true' }, PEGS[colour].symbol));
  if (colour != null && !attrs['aria-label']) node.setAttribute('title', PEGS[colour].name);
  if (size) node.style.setProperty('--size', size);
  return node;
}
const codeLabel = (code) => code.map((c) => PEGS[c].name).join(', ');

// --- account / routing ---

function renderAccount() {
  document.getElementById('nav').hidden = !me;
  document.getElementById('account').hidden = !me;
  document.getElementById('account-name').textContent = me ? me.name : '';
}

async function route() {
  clearInterval(timerHandle);
  document.onkeydown = null;
  const name = (location.hash.replace(/^#\/?/, '') || 'play').split('/')[0];
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const pages = { play: renderPlay, stats: renderStats, leaderboard: renderLeaderboard };
  view.replaceChildren(el('p', { class: 'empty-note' }, 'Loading…'));
  try {
    await (pages[name] || renderPlay)();
  } catch (err) {
    view.replaceChildren(el('p', { class: 'error' }, err.message));
  }
}

// --- play ---

async function renderPlay() {
  const { game } = await api('/games/current');
  if (!game) return renderStart();
  renderGame(game);
}

function renderStart() {
  view.replaceChildren(el('section', { class: 'start card' },
    el('h1', {}, 'Ready to play?'),
    el('p', {}, `The computer hides a code of ${CODE_LENGTH} pegs in 6 colours (colours can repeat). You have ${MAX_GUESSES} guesses. After each guess you get a black peg for every right colour in the right place, and a white peg for every right colour in the wrong place.`),
    el('p', {}, 'Win on guess 1 for 10 points, down to 1 point on guess 10. A loss scores 0 points and counts as 11 guesses.'),
    el('button', { class: 'btn', type: 'button', onclick: startGame }, 'Start a game')));
}

async function startGame() {
  const { game } = await api('/games', { method: 'POST', body: {} });
  renderGame(game);
}

const TIMER_PREF = 'mm.hideTimer';

function renderGame(game) {
  clearInterval(timerHandle);
  const finished = game.status !== 'in_progress';
  // The guess being built: one entry per slot, null while empty.
  const current = new Array(CODE_LENGTH).fill(null);
  // Clock offset so the timer reflects server time even if the device clock is off.
  const skew = Date.now() - new Date(game.serverNow).getTime();
  const started = new Date(game.startedAt).getTime() + skew;

  // The timer is deliberately low-key and can be hidden; time is still
  // recorded on the server for stats either way.
  let timerHidden = localStorage.getItem(TIMER_PREF) === '1';
  const timer = el('span', { class: 'timer', 'aria-live': 'off' });
  const timerToggle = el('button', { class: 'link-btn', type: 'button', onclick: () => {
    timerHidden = !timerHidden;
    localStorage.setItem(TIMER_PREF, timerHidden ? '1' : '0');
    tick();
  } });
  function tick() {
    const end = finished ? new Date(game.finishedAt).getTime() + skew : Date.now();
    timer.textContent = `⏱ ${fmtTime((end - started) / 1000)}`;
    timer.hidden = timerHidden;
    timerToggle.textContent = timerHidden ? 'Show time' : 'Hide';
  }
  tick();
  if (!finished) timerHandle = setInterval(() => { if (!timerHidden) tick(); }, 1000);

  const board = el('div', { class: 'board', role: 'list', 'aria-label': 'Guesses' });
  const submitBtn = el('button', { class: 'btn', type: 'button', onclick: submit }, 'Guess');
  const clearBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { current.fill(null); draw(); } }, 'Clear');
  let busy = false;
  const filled = () => current.filter((c) => c != null).length;

  function feedbackNode(black, white) {
    const dots = [];
    for (let i = 0; i < CODE_LENGTH; i++) {
      dots.push(el('span', { class: `fb ${i < black ? 'black' : i < black + white ? 'white' : ''}` }));
    }
    return el('div', { class: 'row-right' },
      el('span', { class: 'fb-text', 'aria-hidden': 'true' }, black === CODE_LENGTH ? 'all right!' : `${black} placed · ${white} close`),
      el('div', { class: 'feedback', role: 'img', 'aria-label': `${black} right place, ${white} wrong place` }, dots));
  }

  function draw() {
    const rows = [];
    for (let i = 0; i < MAX_GUESSES; i++) {
      const g = game.guesses[i];
      const isActive = !finished && i === game.guesses.length;
      let slots;
      if (g) {
        // Earlier guesses can be dragged down to reuse a colour.
        slots = g.guess.map((c) => peg(c, finished ? {} : { 'data-drag': 'copy', 'data-colour': c }));
      } else if (isActive) {
        slots = current.map((c, j) => c == null
          ? peg(null, { tag: 'button', type: 'button', 'data-slot': j, 'aria-label': `Slot ${j + 1}, empty`, tabindex: '-1' })
          : peg(c, {
              tag: 'button', type: 'button', 'data-slot': j, 'data-drag': 'slot', 'data-colour': c,
              'aria-label': `Slot ${j + 1}, ${PEGS[c].name}. Remove`,
              // Keyboard activation only; pointer clicks are handled by the drag code.
              onclick: (e) => { if (e.detail === 0) { current[j] = null; draw(); } },
            }));
      } else {
        slots = Array.from({ length: CODE_LENGTH }, () => peg(null));
      }
      rows.push(el('div', {
        class: `row ${isActive ? 'active' : ''} ${!g && !isActive ? 'future' : ''}`,
        role: 'listitem',
        'aria-label': g ? `Guess ${i + 1}: ${codeLabel(g.guess)}` : `Guess ${i + 1}`,
      },
        el('span', { class: 'row-num' }, i + 1),
        el('div', { class: 'slots' }, slots),
        g ? feedbackNode(g.black, g.white) : el('div', { class: 'row-right' }, el('span', { class: 'fb-text' }), el('div', { class: 'feedback' }, Array.from({ length: 4 }, () => el('span', { class: 'fb' }))))));
    }
    board.replaceChildren(...rows);
    submitBtn.disabled = busy || filled() !== CODE_LENGTH;
    clearBtn.disabled = busy || filled() === 0;
  }

  function add(c) {
    const free = current.indexOf(null);
    if (finished || free === -1) return;
    current[free] = c;
    draw();
  }

  function undo() {
    for (let j = CODE_LENGTH - 1; j >= 0; j--) {
      if (current[j] != null) { current[j] = null; draw(); return; }
    }
  }

  async function submit() {
    if (busy || filled() !== CODE_LENGTH) return;
    busy = true;
    draw();
    try {
      const res = await api(`/games/${game.id}/guesses`, { method: 'POST', body: { guess: current.slice() } });
      renderGame(res.game);
    } catch (err) {
      busy = false;
      draw();
      toast(err.message);
    }
  }

  async function newGame() {
    if (!finished && !confirm('Start a new game? The current one will count as a loss (0 points).')) return;
    await startGame();
  }

  // --- Drag and drop (pointer events, so mouse and touch behave the same) ---
  // A press that barely moves is a click: palette adds to the first free
  // slot, a placed peg is removed. Otherwise the peg follows the pointer and
  // lands in whichever slot of the active row it is dropped on.
  const DRAG_THRESHOLD = 6;
  let drag = null;

  function slotUnder(x, y) {
    const hit = document.elementFromPoint(x, y)?.closest('[data-slot]');
    return hit && board.contains(hit) ? hit : null;
  }

  function onPointerDown(e) {
    const src = e.target.closest('[data-drag]');
    if (!src || finished || busy || e.button > 0) return;
    e.preventDefault();
    drag = {
      kind: src.dataset.drag,
      colour: Number(src.dataset.colour),
      from: src.dataset.slot != null ? Number(src.dataset.slot) : null,
      src, x: e.clientX, y: e.clientY, ghost: null, target: null,
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', endDrag);
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.ghost = peg(drag.colour);
      drag.ghost.classList.add('drag-ghost');
      document.body.append(drag.ghost);
      drag.src.classList.add('drag-source');
      document.body.classList.add('dragging');
    }
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
    const target = slotUnder(e.clientX, e.clientY);
    if (target !== drag.target) {
      drag.target?.classList.remove('drop-target');
      target?.classList.add('drop-target');
      drag.target = target;
    }
  }

  function onPointerUp(e) {
    if (!drag) return;
    const { kind, colour, from, ghost } = drag;
    if (!ghost) {
      // A click.
      if (kind === 'palette') add(colour);
      else if (kind === 'slot') { current[from] = null; draw(); }
    } else {
      const target = slotUnder(e.clientX, e.clientY);
      if (target) {
        const to = Number(target.dataset.slot);
        if (kind === 'slot') {
          // Moving a placed peg swaps it with whatever was there.
          current[from] = current[to];
        }
        current[to] = colour;
      } else if (kind === 'slot') {
        // Dragged off the row: take it out.
        current[from] = null;
      }
      endDrag();
      draw();
      return;
    }
    endDrag();
  }

  function endDrag() {
    if (!drag) return;
    drag.ghost?.remove();
    drag.src.classList.remove('drag-source');
    drag.target?.classList.remove('drop-target');
    document.body.classList.remove('dragging');
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', endDrag);
    drag = null;
  }

  const palette = el('div', { class: 'palette', role: 'group', 'aria-label': 'Colours' },
    PEGS.map((p, c) => el('div', { class: 'palette-item' },
      peg(c, {
        tag: 'button', type: 'button', 'data-drag': 'palette', 'data-colour': c,
        'aria-label': `Add ${p.name} (key ${c + 1})`, disabled: finished,
        onclick: (e) => { if (e.detail === 0) add(c); },
      }),
      el('span', {}, `${c + 1} · ${p.name}`))));

  let result = null;
  if (finished) {
    const won = game.status === 'won';
    result = el('div', { class: `result ${won ? 'won' : 'lost'}` },
      el('h2', {}, won ? `Cracked in ${game.score} ${game.score === 1 ? 'guess' : 'guesses'}!` : game.status === 'abandoned' ? 'Game abandoned' : 'Out of guesses'),
      el('p', {}, won ? `+${game.points} points.` : 'The code was:'),
      won ? null : el('div', { class: 'slots', 'aria-label': codeLabel(game.secret) }, game.secret.map((c) => peg(c))),
      el('button', { class: 'btn', type: 'button', onclick: startGame }, 'Play again'));
  }

  const status = el('div', { class: 'card status-card' },
    el('span', { class: 'guess-count' }, `Guess ${Math.min(game.guesses.length + (finished ? 0 : 1), MAX_GUESSES)} of ${MAX_GUESSES}`),
    el('span', { class: 'timer-wrap' }, timer, timerToggle));

  const side = el('aside', { class: 'side' },
    result,
    status,
    finished ? null : el('div', { class: 'card picker' },
      el('h3', {}, 'Pick colours'),
      el('p', { class: 'picker-hint' }, 'Drag a colour into any slot, or click to fill the next one.'),
      palette,
      el('div', { class: 'controls' }, clearBtn, submitBtn),
      el('div', { class: 'keys' }, el('kbd', {}, '1'), '–', el('kbd', {}, '6'), ' add · ', el('kbd', {}, '⌫'), ' undo · ', el('kbd', {}, 'Enter'), ' guess')),
    el('div', { class: 'card legend' },
      el('h3', {}, 'Feedback'),
      el('div', {}, el('span', { class: 'fb black' }), 'Right colour, right place'),
      el('div', {}, el('span', { class: 'fb white' }), 'Right colour, wrong place')),
    finished ? null : el('button', { class: 'btn btn-ghost btn-small give-up', type: 'button', onclick: newGame }, 'Give up & start new game'));

  const section = el('section', { class: 'game' }, board, side);
  section.addEventListener('pointerdown', onPointerDown);
  view.replaceChildren(section);

  document.onkeydown = finished ? null : (e) => {
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-6]$/.test(e.key)) { add(Number(e.key) - 1); e.preventDefault(); }
    else if (e.key === 'Backspace') { undo(); e.preventDefault(); }
    else if (e.key === 'Enter' && !e.target.closest('button')) { submit(); e.preventDefault(); }
  };
  draw();
}

// --- stats ---

function tile(label, value, sub) {
  return el('div', { class: 'tile' },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, value),
    sub ? el('div', { class: 'tile-sub' }, sub) : null);
}

/** Single-series histogram of guesses-per-game; 11 is drawn as "Lost". */
function histogram(data) {
  const W = 640, H = 260, m = { t: 20, r: 8, b: 34, l: 36 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = max <= 5 ? 1 : Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const y = (v) => m.t + ih - (v / top) * ih;
  const band = iw / data.length;
  const gap = 2;
  const bw = Math.min(44, band - gap * 4);
  const total = data.reduce((a, d) => a + d.count, 0);

  const wrap = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tooltip', hidden: true });
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Histogram of guesses per game' });

  const grid = svg('g', { class: 'grid' });
  for (let v = 0; v <= top; v += step) {
    if (v > 0) grid.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    grid.append(svg('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, v));
  }
  root.append(grid);

  const axis = svg('g', { class: 'axis' });
  data.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const loss = d.score >= LOSS_SCORE;
    axis.append(svg('text', { x: cx, y: H - m.b + 20, 'text-anchor': 'middle' }, loss ? 'Lost' : d.score));
    const col = svg('g', { class: 'bar-col' });
    if (d.count > 0) {
      const h = Math.max(2, (d.count / top) * ih);
      const x = cx - bw / 2, yTop = m.t + ih - h, r = Math.min(4, h, bw / 2);
      // Rounded at the data end only; flat on the baseline.
      const path = `M${x},${m.t + ih} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${m.t + ih} Z`;
      col.append(svg('path', { class: `bar ${loss ? 'loss' : ''}`, d: path }));
      col.append(svg('text', { class: 'val', x: cx, y: yTop - 6, 'text-anchor': 'middle' }, d.count));
    }
    // Hit target: the full column, bigger than the bar.
    const hit = svg('rect', { class: 'bar-hit', x: m.l + band * i, y: m.t, width: band, height: ih });
    hit.addEventListener('pointerenter', () => {
      const pct = total ? Math.round((d.count / total) * 100) : 0;
      tip.textContent = `${loss ? 'Lost / abandoned' : `Won in ${d.score}`}: ${d.count} ${d.count === 1 ? 'game' : 'games'} (${pct}%)`;
      tip.hidden = false;
      const box = wrap.getBoundingClientRect();
      const scale = box.width / W;
      tip.style.left = `${Math.min(box.width - 180, Math.max(0, cx * scale - 60))}px`;
      tip.style.top = `${Math.max(0, y(d.count) * scale - 44)}px`;
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    col.append(hit);
    root.append(col);
  });
  root.append(svg('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }));
  root.append(axis);
  wrap.append(root, tip);
  return wrap;
}

async function renderStats() {
  const { summary: s, histogram: hist, recent } = await api('/stats/me');
  const head = el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, 'My stats'), el('p', {}, 'Score = guesses needed to win. A loss or abandoned game counts as 11.')));

  if (!s.games) {
    view.replaceChildren(head, el('div', { class: 'card start' },
      el('p', {}, 'No finished games yet.'),
      el('a', { class: 'btn', href: '#/play' }, 'Play your first game')));
    return;
  }

  const winRate = Math.round((s.wins / s.games) * 100);
  const tiles = el('div', { class: 'tiles' },
    tile('Games played', s.games, `${s.wins} won · ${s.losses} lost · ${s.abandoned} abandoned`),
    tile('Win rate', `${winRate}%`),
    tile('Average score', fmt1(s.avg_score), 'guesses per game'),
    tile('Median score', fmt1(s.median_score), 'guesses per game'),
    tile('Total points', s.points, `${fmt1(s.points / s.games)} per game`),
    tile('Best game', s.best_score ?? '–', s.best_score ? (s.best_score === 1 ? 'guess' : 'guesses') : 'no wins yet'),
    tile('Average win time', fmtTime(s.avg_win_seconds), s.fastest_win_seconds != null ? `fastest ${fmtTime(s.fastest_win_seconds)}` : null));

  let showTable = false;
  const chartBody = el('div');
  const toggle = el('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-pressed': 'false' }, 'Show table');
  const drawChart = () => {
    toggle.textContent = showTable ? 'Show chart' : 'Show table';
    toggle.setAttribute('aria-pressed', String(showTable));
    chartBody.replaceChildren(showTable
      ? el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Guesses'), el('th', { class: 'num' }, 'Games'))),
          el('tbody', {}, hist.map((d) => el('tr', {}, el('td', {}, scoreLabel(d.score)), el('td', { class: 'num' }, d.count)))))
      : el('div', {}, histogram(hist),
          el('div', { class: 'chart-key' },
            el('span', {}, el('i', { class: 'swatch' }), 'Wins'),
            el('span', {}, el('i', { class: 'swatch loss' }), 'Lost or abandoned'))));
  };
  toggle.addEventListener('click', () => { showTable = !showTable; drawChart(); });
  drawChart();

  const chartCard = el('div', { class: 'card chart-card' },
    el('div', { class: 'chart-head' }, el('h2', {}, 'Guesses per game'), toggle),
    chartBody);

  const recentTable = el('div', { class: 'card' },
    el('h2', {}, 'Recent games'),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Result'), el('th', { class: 'num' }, 'Guesses'),
        el('th', { class: 'num' }, 'Points'), el('th', { class: 'num' }, 'Time'))),
      el('tbody', {}, recent.map((g) => el('tr', {},
        el('td', {}, new Date(g.finished_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
        el('td', {}, el('span', { class: `badge ${g.status}` }, g.status)),
        el('td', { class: 'num' }, scoreLabel(g.score)),
        el('td', { class: 'num' }, g.points),
        el('td', { class: 'num' }, fmtTime(g.seconds)))))));

  view.replaceChildren(head, tiles, chartCard, recentTable);
}

// --- leaderboard ---

async function renderLeaderboard() {
  const lb = await api('/leaderboard');
  const board = (title, rows, cols) => el('div', { class: 'card' },
    el('h2', {}, title),
    rows.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, el('th', { class: 'rank' }, '#'), el('th', {}, 'Player'),
            cols.map((c) => el('th', { class: 'num' }, c.label)))),
          el('tbody', {}, rows.map((r, i) => el('tr', { class: String(r.id) === String(lb.me) ? 'me' : '' },
            el('td', { class: 'rank' }, i + 1),
            el('td', {}, r.name),
            cols.map((c) => el('td', { class: 'num' }, c.value(r)))))))
      : el('p', { class: 'empty-note' }, `Nobody has finished ${lb.minGames} games yet.`));

  view.replaceChildren(
    el('div', { class: 'page-head' }, el('div', {},
      el('h1', {}, 'Leaderboard'),
      el('p', {}, `Players appear after finishing ${lb.minGames} games. Losses and abandoned games count as 11 guesses and 0 points.`))),
    el('div', { class: 'boards' },
      board('Best average', lb.bestAverage, [
        { label: 'Avg guesses', value: (r) => fmt1(r.avg_score) },
        { label: 'Games', value: (r) => r.games },
      ]),
      board('Most points', lb.mostPoints, [
        { label: 'Points', value: (r) => r.points },
        { label: 'Games', value: (r) => r.games },
      ])));
}

// --- boot ---

window.addEventListener('hashchange', route);
(async () => {
  try {
    ({ user: me } = await api('/me'));
  } catch (err) {
    view.replaceChildren(el('section', { class: 'start card' },
      el('h1', {}, 'Who are you?'),
      el('p', {}, err.message)));
    return;
  }
  renderAccount();
  route();
})();
