#!/usr/bin/env node
/**
 * test_scoring.mjs —— 无浏览器逻辑测试（node:vm 模拟最小 DOM）
 *
 * 用法：node tools/test_scoring.mjs
 *
 * 覆盖：计分与反向计分正确性、CSV 解析/校验/回退、完成态欢迎页、
 * 续答、施测计时、质量旗标、dev 填充、提交流程。
 * 不覆盖：真实浏览器渲染（另见无头浏览器冒烟测试）。
 */
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'test.html');
const csvPath = path.join(root, 'items.csv');

const html = readFileSync(htmlPath, 'utf8');
const sm = html.match(/<script>([\s\S]*?)<\/script>/);
if (!sm) { console.error('FAIL: 未找到 <script> 块'); process.exit(1); }
const code = sm[1];
const csvText = readFileSync(csvPath, 'utf8');

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(id) {
  const el = {
    id: id || '',
    tagName: 'div',
    style: {},
    dataset: {},
    children: [],
    _listeners: {},
    innerHTML: '',
    scrollTop: 0,
    disabled: false,
    value: '',
    checked: false,
    files: null,
    attrs: {},
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = v === null || v === undefined ? '' : String(v); }, // 与真实 DOM 一致：强制转字符串
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    select() {},
    scrollTo() {}, // 真实元素有；桩缺失会让 tryFinish 的滚动定位走 catch 分支
    click() { (this._listeners.click || []).slice().forEach(fn => fn.call(el, { type: 'click' })); },
    getBoundingClientRect() { return { top: 0, height: 0 }; },
    // Canvas 2D 桩：记录绘制调用，供导出布局断言使用（不真实渲染）
    width: 0,
    height: 0,
    getContext(kind) {
      if (kind !== '2d') return null;
      const ops = el.__ops = el.__ops || [];
      const noop = () => {};
      const ctx = {
        __ops: ops,
        canvas: el,
        scale: noop, fillRect: noop, clearRect: noop, drawImage: noop,
        beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
        arc: noop, stroke: noop, fill: noop, save: noop, restore: noop,
        setLineDash: noop, translate: noop, rotate: noop,
        fillText(t, x, y) { ops.push({ op: 'fillText', text: String(t), x, y }); },
        strokeText: noop,
        measureText(t) { return { width: String(t).length * 6 }; },
      };
      // font/fillStyle/strokeStyle/lineWidth/textAlign/textBaseline/globalAlpha/lineJoin 直接当普通属性
      return ctx;
    },
    toDataURL() { return 'data:image/png;base64,STUB'; },
  };
  return el;
}

function makeWorld(opts = {}) {
  const els = new Map();
  const docListeners = {};
  const storage = new Map();
  const screens = ['welcome', 'test', 'result'].map(id => {
    const el = makeEl(id);
    el.classList.add('screen');
    return el;
  });
  els.set('welcome', screens[0]);
  els.set('test', screens[1]);
  els.set('result', screens[2]);
  screens[0].classList.add('active');

  const documentStub = {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    hidden: false,
    title: 'HEXACO 人格测试',
    __listeners: docListeners,
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel === '.screen') return screens;
      return [];
    },
    createElement(tag) {
      const el = makeEl(tag);
      el.tagName = tag;
      return el;
    },
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    removeEventListener() {},
    execCommand() { return true; },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: documentStub,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    location: { hash: '', reload() {} },
    navigator: { clipboard: null },
    requestAnimationFrame: fn => { fn(); return 1; },
    Event: class Event { constructor(t) { this.type = t; } },
    FileReader: class FileReader { readAsText() {} },
    setTimeout, clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    print() {},
    // cssVar() 走 getComputedStyle；桩返回空串，让 cssVar 落到调用方给的兜底色
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    // 真实浏览器有视口尺寸；缺失会让键盘作答的“最近题目”判定算出 NaN 而永不命中
    innerWidth: 1280,
    innerHeight: 900,
  };
  sandbox.window = sandbox;
  if (opts.fetchImpl) sandbox.fetch = opts.fetchImpl;
  vm.createContext(sandbox);

  return {
    sandbox, els, docListeners, storage, screens,
    run(expr) { return vm.runInContext(expr, sandbox, { filename: 'test-' + Math.random() + '.js' }); },
    tick(ms = 30) { return new Promise(r => setTimeout(r, ms)); },
  };
}

async function bootWorld(opts) {
  const w = makeWorld(opts);
  vm.runInContext(code, w.sandbox, { filename: 'hexaco-inline.js' });
  await w.tick(); // 等待 loadItemBank().then(initWelcome)
  return w;
}

/* ---------------- 断言工具 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  // 断言体常用 `return 条件 || '失败原因'` 的写法：失败时返回非空字符串，
  // 而字符串是 truthy —— 若只判 truthy 就会把失败误记为通过。
  // 因此显式排除字符串，让这类断言正确失败（原因仍由 extra 或返回值给出）。
  const ok = typeof cond === 'string' ? false : !!cond;
  if (ok) { pass++; }
  else {
    const why = typeof cond === 'string' ? cond : extra;
    fail++; failures.push(name + (why ? ' :: ' + why : ''));
    console.error('  FAIL: ' + name + (why ? ' :: ' + why : ''));
  }
}
function section(t) { console.log('— ' + t); }

/* ---------------- 场景 A：file://（无 fetch），空存储 ---------------- */
{
  section('A: file:// 兜底 + 核心逻辑');
  const w = await bootWorld();

  check('A1 题本来源=内置', w.run('itemsSource') === 'builtin');
  check('A1b data-items-source 属性', w.run(`document.documentElement.getAttribute('data-items-source')`) === 'builtin');
  check('A2 题量/页数', w.run('N_ITEMS') === 100 && w.run('TOTAL_PAGES') === 20);

  // 全 3 分 → 一切 3.00
  w.run(`(() => { for (let i = 0; i < N_ITEMS; i++) answers[i] = 3; return true; })()`);
  check('A3 全 3 → 3.00', w.run(`(() => {
    const s = computeScores();
    return Object.values(s.factorScores).every(v => v === '3.00')
      && Object.values(s.facetScores).every(f => Object.values(f).every(v => v === '3.00'))
      && s.altruism === '3.00';
  })()`));

  // 反向计分：反向题答 1 / 正向题答 5 → 计分后全 5
  w.run(`(() => { for (let i = 0; i < N_ITEMS; i++) answers[i] = reverseSet.has(i + 1) ? 1 : 5; return true; })()`);
  check('A4 反向题答1+正向题答5 → 5.00', w.run(`(() => {
    const s = computeScores();
    return Object.values(s.factorScores).every(v => v === '5.00') && s.altruism === '5.00';
  })()`));
  // 反向题答 5 / 正向题答 1 → 计分后全 1
  w.run(`(() => { for (let i = 0; i < N_ITEMS; i++) answers[i] = reverseSet.has(i + 1) ? 5 : 1; return true; })()`);
  check('A5 反向题答5+正向题答1 → 1.00', w.run(`(() => {
    const s = computeScores();
    return Object.values(s.factorScores).every(v => v === '1.00') && s.altruism === '1.00';
  })()`));

  // 未作答防护
  check('A6 未作答防护', w.run(`(() => {
    const old = answers[0]; answers[0] = 0;
    try { computeScores(); return false; }
    catch (e) { return /第 1 题/.test(e.message); }
    finally { answers[0] = old; }
  })()`));

  // CSV 往返：解析生成的 CSV → 与内置完全一致
  const csvJson = JSON.stringify(csvText);
  check('A7 CSV 解析成功', w.run(`(() => { const p = parseItemCsv(${csvJson}); return p.ok === true; })()`));
  check('A8 CSV 往返一致（题目/反向/结构）', w.run(`(() => {
    const p = parseItemCsv(${csvJson});
    if (!p.ok) return 'parse: ' + p.error;
    const qSame = JSON.stringify(p.bank.questions) === JSON.stringify(questions);
    const rSame = JSON.stringify(Array.from(p.bank.reverse).sort((a, b) => a - b)) === JSON.stringify(reverseScoredItems.slice().sort((a, b) => a - b));
    let kSame = true;
    for (const f of FACTOR_ORDER) for (const fa of FACET_ORDER[f])
      if (JSON.stringify(p.bank.facets[f][fa]) !== JSON.stringify(scoringKeys[f][fa])) kSame = false;
    const aSame = JSON.stringify(p.bank.altruism) === JSON.stringify(altruismItems);
    return (qSame && rSame && kSame && aSame) || 'mismatch q:' + qSame + ' r:' + rSame + ' k:' + kSame + ' a:' + aSame;
  })()`));

  // 应用 CSV 后状态一致（幂等）
  w.run(`(() => { const p = parseItemCsv(${csvJson}); if (p.ok) applyItemBank(p.bank); return true; })()`);
  check('A9 applyItemBank 幂等', w.run(`N_ITEMS === 100 && questions.length === 100 && reverseScoredItems.length === 50`));

  // 篡改 CSV → 全部应被拒绝
  const tamper = (mut) => w.run(`(() => {
    let t = ${csvJson};
    ${mut}
    const p = parseItemCsv(t);
    return p.ok ? 'accepted!' : 'rejected';
  })()`);
  check('A10a 缺行被拒', tamper(`t = t.replace(/100,[^\\r\\n]*\\r?\\n?/g, '');`) === 'rejected');
  check('A10b 坏表头被拒', tamper(`t = t.replace('题号', '编号');`) === 'rejected');
  check('A10c 未知领域被拒', tamper(`t = t.replace('情绪性,恐惧性', '未知域,恐惧性');`) === 'rejected');
  check('A10d 重复题号被拒', tamper(`t = t.replace(/^5,/m, '3,');`) === 'rejected');
  check('A10e 侧面题数异常被拒', tamper(`t = t.replace(/^29,/m, '30,');`) === 'rejected'); // 29 挪给 Modesty → 两个侧面题数都不对
  check('A10f 空题被拒', tamper(`t = t.replace(/^1,([^,]+),/m, '1,,');`) === 'rejected');

  // loadProgress 校验
  check('A11a 坏 JSON → null', w.run(`(() => {
    localStorage.setItem('hexaco_progress_v1', 'not-json');
    return loadProgress() === null;
  })()`));
  check('A11b 非法取值 → null', w.run(`(() => {
    const a = new Array(100).fill(3); a[7] = 9;
    localStorage.setItem('hexaco_progress_v1', JSON.stringify({ answers: a, page: 0, meta: null }));
    return loadProgress() === null;
  })()`));
  check('A11c 合法数据 + 脏 meta → 清洗后恢复', w.run(`(() => {
    const a = new Array(100).fill(3);
    localStorage.setItem('hexaco_progress_v1', JSON.stringify({ answers: a, page: 999, meta: { sessions: 'x', activeMs: -5, devFill: 1 } }));
    const d = loadProgress();
    return !!d && d.page === 19 && d.meta.sessions === 1 && d.meta.activeMs === 0 && d.meta.devFill === true;
  })()`));

  // B1：完成态欢迎页
  check('A12 完成态 → 查看结果', w.run(`(() => {
    const a = new Array(100).fill(3);
    localStorage.setItem('hexaco_progress_v1', JSON.stringify({ answers: a, page: 19, meta: {} }));
    initWelcome();
    return document.getElementById('welcomeActions').innerHTML.includes('查看结果')
      && document.getElementById('resumeNote').textContent.includes('已完成全部');
  })()`));
  check('A13 点击“查看结果”→ 渲染结果页', w.run(`(() => {
    document.getElementById('resumeBtn').click();
    return lastScores !== null && document.getElementById('result').classList.contains('active')
      && Object.values(lastScores.factorScores).every(v => v === '3.00');
  })()`));

  // 续答分支（部分作答）
  check('A14 部分作答 → 继续测试（而非查看结果）', w.run(`(() => {
    const a = new Array(100).fill(0); for (let i = 0; i < 50; i++) a[i] = 3;
    localStorage.setItem('hexaco_progress_v1', JSON.stringify({ answers: a, page: 4, meta: {} }));
    initWelcome();
    const h = document.getElementById('welcomeActions').innerHTML;
    return h.includes('继续测试') && !h.includes('查看结果');
  })()`));

  // 施测计时
  check('A15 答题屏切后台：120s 封顶 + 记截断', w.run(`(() => {
    meta = freshMeta();
    lastEventTs = Date.now() - 200000;
    document.getElementById('test').classList.add('active');
    document.hidden = true;
    document.__listeners.visibilitychange[0]();
    return meta.activeMs === 120000 && meta.truncated === 1 && lastEventTs === null;
  })()`));
  check('A16 结果页切后台：不计时', w.run(`(() => {
    meta = freshMeta();
    showScreen('result');
    lastEventTs = Date.now() - 200000;
    document.hidden = true;
    document.__listeners.visibilitychange[0]();
    return meta.activeMs === 0 && meta.truncated === 0;
  })()`));
  check('A17 离开答题屏即停表', w.run(`(() => {
    showScreen('test'); lastEventTs = Date.now();
    showScreen('result');
    return lastEventTs === null;
  })()`));

  // 质量旗标
  check('A18 直线作答旗标', w.run(`(() => {
    for (let i = 0; i < N_ITEMS; i++) answers[i] = 4;
    meta = freshMeta();
    const m = metaSummary();
    return m.longestRun === 100 && m.flags.some(f => f.includes('直线作答'));
  })()`));

  // 完整提交流程（键盘/按钮驱动）；中点作答时反向题 6−3=3，总分应全 3.00
  check('A19 末页“查看结果”→ 结果页', w.run(`(() => {
    localStorage.removeItem('hexaco_progress_v1');
    startFresh();
    for (let i = 0; i < N_ITEMS; i++) answers[i] = 3;
    page = TOTAL_PAGES - 1;
    renderPage();
    document.getElementById('nextBtn').click();
    return lastScores !== null && document.getElementById('result').classList.contains('active')
      && Object.values(lastScores.factorScores).every(v => v === '3.00');
  })()`));

  // 未答完 → 跳回第一未答题
  check('A20 未答完提交 → 提示并跳页', w.run(`(() => {
    startFresh();
    for (let i = 0; i < 90; i++) answers[i] = 2;
    page = TOTAL_PAGES - 1;
    renderPage();
    document.getElementById('nextBtn').click();
    return page === Math.floor(90 / 5) && !document.getElementById('result').classList.contains('active');
  })()`));

  // 键盘数字键（数值比较；stub 无题目列表 → 只验证不抛错）
  check('A21 键盘事件不抛错', w.run(`(() => {
    document.getElementById('test').classList.add('active');
    const h = document.__listeners.keydown[0];
    h({ key: '5' }); h({ key: '9' }); h({ key: 'ArrowRight' }); h({ key: 'x' });
    return true;
  })()`));

  // dev 填充
  check('A22 dev 填充各模式合法', w.run(`(() => {
    for (const mode of ['random', 'high', 'low', 'normal', 'gradient']) {
      const a = devFill(mode);
      if (a.length !== 100) return 'len ' + mode;
      for (const v of a) if (!(v >= 1 && v <= 5)) return 'range ' + mode;
    }
    const hi = devFill('high'); if (!hi.every(v => v === 5)) return 'high';
    const lo = devFill('low'); if (!lo.every(v => v === 1)) return 'low';
    return true;
  })()`));

  // ---- 本次改动新增断言 ----

  // Ctrl+P 空页修复：renderResults 必须预填充 #printReport
  check('A23 renderResults 预填充打印报告', w.run(`(() => {
    document.getElementById('printReport').innerHTML = '';
    for (let i = 0; i < N_ITEMS; i++) answers[i] = 3;
    renderResults();
    const h = document.getElementById('printReport').innerHTML;
    return h.includes('HEXACO 人格测试报告') && h.includes('计分方法与使用说明');
  })()`));

  // 雷达图标签坐标必须落在 viewBox 内，否则会被裁切。
  // 注：SVG 里的 CSS px 字号不随 viewBox 缩放，所以窄屏下标签始终是 12px，
  // 本断言只锁「不被裁切」这一真实约束，不假设字号会随宽度变化。
  check('A24 雷达 viewBox 覆盖标签不被裁切', w.run(`(() => {
    for (let i = 0; i < N_ITEMS; i++) answers[i] = 3;
    const svg = buildRadar(computeScores().factorScores, Object.keys(scoringKeys));
    const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
    if (!vb) return 'no viewBox';
    const parts = vb.split(' ').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return 'bad viewBox: ' + vb;
    const [vx, vy, vw, vh] = parts;
    // 取所有标签 text 的坐标，须全部落在 viewBox 内（留 20 单位给字宽/字高）
    const xs = [...svg.matchAll(/<text[^>]*x="(-?[0-9.]+)"/g)].map(m => +m[1]);
    const ys = [...svg.matchAll(/<text[^>]*y="(-?[0-9.]+)"/g)].map(m => +m[1]);
    if (xs.length < 6 || ys.length < 6) return 'too few labels: ' + xs.length + '/' + ys.length;
    // 余量取 4：只需覆盖 12px 字号的下伸部（约 3px）。
    // 原始代码底部只剩 3 单位，属贴边侥幸；PAD=8 后余量 11，留 4 作门槛。
    const M = 4;
    const inside = (v, lo, hi) => v >= lo + M && v <= hi - M;
    return xs.every(x => inside(x, vx, vx + vw)) && ys.every(y => inside(y, vy, vy + vh))
      || 'label outside viewBox vb=' + vb + ' xs=' + xs.map(v => v.toFixed(0)) + ' ys=' + ys.map(v => v.toFixed(0));
  })()`));

  // PNG 概览卡：利他主义必须是独立成行（与六大领域同字号），且不得超出画布高度
  check('A25 PNG 卡利他主义独立成行且不溢出', w.run(`(() => {
    for (let i = 0; i < N_ITEMS; i++) answers[i] = 3;
    lastScores = computeScores();
    const cv = drawOverviewCard();
    const ops = (cv.getContext('2d') && cv.__ops) || cv.__ops;
    if (!ops || !ops.length) return 'no draw ops';
    const H = cv.height / 2; // 2x 输出，逻辑高度
    const texts = ops.filter(o => o.op === 'fillText');
    const alt = texts.find(t => t.text.indexOf('利他主义') === 0);
    if (!alt) return 'missing altruism label';
    if (alt.text === '利他主义（居间量表）') return 'still crammed as footnote';
    // 与六大领域标签同字号（14px 档），而非页脚小字
    const domain = texts.find(t => t.text === factorZh[FACTOR_ORDER[0]]);
    if (!domain) return 'missing domain label';
    if (Math.abs(alt.y - domain.y) < 10) return 'altruism overlaps a domain row';
    if (alt.y > H) return 'altruism below canvas: y=' + alt.y + ' H=' + H;
    const footer = texts[texts.length - 1];
    if (footer.y > H) return 'footer below canvas: y=' + footer.y + ' H=' + H;
    return true;
  })()`));

  // 「返回修改」：保留作答与施测元数据，仅回到答题屏
  check('A26 返回修改保留作答与元数据', w.run(`(() => {
    for (let i = 0; i < N_ITEMS; i++) answers[i] = 4;
    meta = freshMeta(); meta.activeMs = 12345; meta.sessions = 2;
    renderResults();
    document.getElementById('editBtn').click();
    return document.getElementById('test').classList.contains('active')
      && !document.getElementById('result').classList.contains('active')
      && answers.every(v => v === 4)
      && meta.activeMs === 12345 && meta.sessions === 2
      && lastScores === null;
  })()`));

  // 「返回修改」后重新提交应基于修改后的作答重新计分。
  // 注意：全答 1 时反向题按 6−1 折算成 5，领域分是 2.75 而非 1.00；
  // 要得到全 1.00 必须按反向标记作答（见 A5）。
  check('A27 返回修改后可重新计分', w.run(`(() => {
    for (let i = 0; i < N_ITEMS; i++) answers[i] = reverseSet.has(i + 1) ? 5 : 1;
    page = TOTAL_PAGES - 1;
    renderPage();
    document.getElementById('nextBtn').click();
    return document.getElementById('result').classList.contains('active')
      && Object.values(lastScores.factorScores).every(v => v === '1.00');
  })()`));

  // 「重新测试」仍会清空（与返回修改形成对照）
  check('A28 重新测试清空作答', w.run(`(() => {
    document.getElementById('restartBtn').click();
    return document.getElementById('welcome').classList.contains('active')
      && lastScores === null && answers.every(v => v === 0);
  })()`));

  // 数字键作答后焦点移到被选中的控件（屏幕阅读器可播报）
  // 桩的 querySelectorAll 恒返回 []，这里在沙箱内注入一个假题目；
  // 注意：不能用 document.querySelectorAll.bind(document) 保存原函数——
  // document 是沙箱全局而非词域内变量，bind 会抛 ReferenceError。
  check('A29 数字键作答移动焦点', w.run(`(() => {
    const calls = [];
    const fakeInput = {
      checked: false,
      focus(o) { calls.push('focus:' + JSON.stringify(o)); },
      dispatchEvent(ev) { calls.push('change:' + ev.type); }
    };
    const fakeQ = { querySelector: () => fakeInput, getBoundingClientRect: () => ({ top: 100, height: 40 }) };
    const orig = document.querySelectorAll;
    document.querySelectorAll = (sel) => (sel === '.question' ? [fakeQ] : []);
    try {
      document.getElementById('test').classList.add('active');
      document.__listeners.keydown[0]({ key: '3' });
    } finally { document.querySelectorAll = orig; }
    // 必须先 focus 再 change，顺序错了播报内容就是上一题
    return fakeInput.checked === true
      && calls.length === 2 && calls[0].startsWith('focus:') && calls[1] === 'change:change';
  })()`));
}

/* ---------------- 场景 B：http + 有效 CSV ---------------- */
{
  section('B: http 加载外部 CSV');
  const w = await bootWorld({ fetchImpl: async () => ({ ok: true, text: async () => csvText }) });
  check('B1 题本来源=csv', w.run('itemsSource') === 'csv');
  check('B2 CSV 数据生效（与内置一致）', w.run(`questions.length === 100 && reverseScoredItems.length === 50 && N_ITEMS === 100`));
  check('B3 欢迎页已渲染（题量文案）', w.run(`document.getElementById('welcomeCount').textContent === '100'`));
}

/* ---------------- 场景 C：http + 坏 CSV ---------------- */
{
  section('C: http 加载坏 CSV → 兜底 + 提示');
  const w = await bootWorld({ fetchImpl: async () => ({ ok: true, text: async () => '题号,题目,坏表头\n1,x,y\n' }) });
  check('C1 回退内置', w.run('itemsSource') === 'builtin');
  check('C2 有提示', w.run(`document.getElementById('toast').textContent.includes('校验失败')`));
}

/* ---------------- 场景 D：file:// + 本地导入（localStorage） ---------------- */
{
  section('D: dev 导入题本（localStorage）');
  const w = makeWorld();
  w.storage.set('hexaco_items_csv_v1', csvText);
  vm.runInContext(code, w.sandbox, { filename: 'hexaco-inline.js' });
  await w.tick();
  check('D1 题本来源=local', w.run('itemsSource') === 'local');
  check('D2 导入数据生效', w.run(`questions.length === 100`));

  // 坏导入 → 清除 + 兜底
  const w2 = makeWorld();
  w2.storage.set('hexaco_items_csv_v1', 'garbage');
  vm.runInContext(code, w2.sandbox, { filename: 'hexaco-inline.js' });
  await w2.tick();
  check('D3 坏导入被清除并兜底', w2.run('itemsSource') === 'builtin' && w2.storage.get('hexaco_items_csv_v1') === undefined);
}

/* ---------------- 场景 E：静态资源与页面元数据 ---------------- */
{
  section('E: 页面元数据 / favicon / 发布清单');
  const pages = ['index.html', 'test.html', '404.html'];
  const src = Object.fromEntries(pages.map(f => [f, readFileSync(path.join(root, f), 'utf8')]));

  for (const f of pages) {
    const h = src[f];
    check(`E ${f} 有内联 SVG favicon`, /rel="icon" href="data:image\/svg\+xml,/.test(h));
    check(`E ${f} favicon 无裸 # 且标签配对`, (() => {
      const m = h.match(/rel="icon" href="data:image\/svg\+xml,([^"]+)"/);
      if (!m) return 'no favicon';
      const raw = m[1];
      if (raw.replace(/%23/g, '').includes('#')) return 'bare # truncates data URI';
      const svg = decodeURIComponent(raw);
      const open = (svg.match(/<(?:svg|polygon)\b/g) || []).length;
      const close = (svg.match(/<\/svg>/g) || []).length + (svg.match(/\/>/g) || []).length;
      return (open === close && svg.startsWith('<svg') && svg.endsWith('</svg>')) || `unbalanced ${open}/${close}`;
    })());
    check(`E ${f} 有 theme-color`, h.includes('name="theme-color"'));
  }

  // 落地页与测试页需要分享卡片；404 不需要
  for (const f of ['index.html', 'test.html']) {
    const h = src[f];
    const need = ['og:type', 'og:title', 'og:description', 'og:url', 'twitter:card'];
    const miss = need.filter(k => !h.includes(k));
    check(`E ${f} og/twitter 完整`, miss.length === 0 || '缺: ' + miss.join(','));
  }

  // 落地页入口必须指向存在的文件（改名时最容易漏）
  const cta = (src['index.html'].match(/class="cta" href="([^"]+)"/) || [])[1];
  check('E 落地页 CTA 指向真实文件', !!cta && existsSync(path.join(root, cta)) || 'cta=' + cta);
  const csvHref = (src['index.html'].match(/href="(items\.csv)"/) || [])[1];
  check('E 落地页题本链接指向真实文件', !!csvHref && existsSync(path.join(root, csvHref)) || 'csv=' + csvHref);

  // CI 发布清单里的文件都必须存在
  const yml = readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  const cpLine = (yml.match(/cp ([^\n]+) _site\//) || [])[1];
  check('E CI 有显式 cp 清单', !!cpLine || '未找到 cp 清单');
  if (cpLine) {
    const missing = cpLine.trim().split(/\s+/).filter(f => !existsSync(path.join(root, f)));
    check('E CI 清单文件齐全', missing.length === 0 || '缺: ' + missing.join(','));
  }
  // CI 必须在部署前跑自测：接受 `npm test` 或直接调脚本两种写法，
  // 但 deploy 必须 needs 到 test（门禁真实生效，不是并列跑）
  const testGate = /run:\s*(npm test|node tools\/test_scoring\.mjs)/.test(yml);
  const deployNeeds = /needs:\s*(\[.*\btest\b.*\]|\btest\b)/.test(yml);
  check('E CI 部署前跑自测', (testGate && deployNeeds) || `testGate=${testGate} deployNeeds=${deployNeeds}`);

  // job 依赖链：deploy 必须同时 needs test 与 smoke（冒烟测试也是门禁）
  {
    const jobs = [...yml.replace(/\r\n/g, '\n').matchAll(/^ {2}([A-Za-z][\w-]*):$/gm)].map(m => m[1]);
    const missing = ['test', 'smoke', 'deploy', 'verify'].filter(j => !jobs.includes(j));
    check('E CI 四个 job 齐全', missing.length === 0 || '缺: ' + missing.join(','));
    const deployIdx = yml.indexOf('  deploy:');
    const needsLine = yml.slice(deployIdx, deployIdx + 400).match(/needs:\s*([^\n]+)/);
    const list = needsLine ? needsLine[1].replace(/[[\]]/g, '').split(',').map(s => s.trim()) : [];
    check('E deploy needs test+smoke',
      (list.includes('test') && list.includes('smoke')) || 'needs=' + list.join(','));
    // needs 引用的 job 必须真实存在
    const allNeeds = [...yml.matchAll(/needs:\s*(\[[^\]]*\]|[\w-]+)/g)]
      .flatMap(m => (m[1].startsWith('[') ? m[1].slice(1, -1).split(',') : [m[1]]).map(s => s.trim()));
    const dangling = allNeeds.filter(j => !jobs.includes(j));
    check('E needs 引用有效', dangling.length === 0 || '悬空: ' + dangling.join(','));
  }

  // 线上核验：必须挂在部署之后，且不得另写一份发布文件表（清单只能有一个来源）
  {
    const verifyIdx = yml.indexOf('  verify:');
    const vNeeds = verifyIdx < 0 ? '' : ((yml.slice(verifyIdx, verifyIdx + 500).match(/needs:\s*([^\n]+)/) || [])[1] || '');
    check('E verify needs deploy', vNeeds.includes('deploy'), 'needs=' + (vNeeds.trim() || '无'));
    check('E verify 跑 tools/test_live.mjs', /run:\s*node tools\/test_live\.mjs/.test(yml));
    const pkgScripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
    check('E package.json 有 test:live', pkgScripts['test:live'] === 'node tools/test_live.mjs',
      'scripts.test:live=' + pkgScripts['test:live']);
    const liveTool = readFileSync(path.join(root, 'tools/test_live.mjs'), 'utf8');
    check('E test_live 的清单取自 pages.yml（不重复维护文件表）',
      liveTool.includes('pages.yml') && liveTool.includes('cp (['));
    check('E test_live 用 git blob 当期望值（绕开 autocrlf）',
      liveTool.includes("'show'") && liveTool.includes('HEAD:'));
  }

  // action：全部钉到 commit SHA（防 tag 被移动）、带版本注释、主版本不低于 v5
  // （v4 及更早的官方 action 仍跑在已弃用的 Node 20 上，会产生告警）
  {
    const lines = yml.split(/\r?\n/).filter(l => /uses:/.test(l));
    const problems = [];
    for (const l of lines) {
      const m = l.match(/uses:\s*([\w./-]+)@(v(\d+)|([0-9a-f]{40}))/);
      if (!m) { problems.push('无法解析: ' + l.trim()); continue; }
      const name = m[1];
      const major = m[3] ? +m[3] : +((l.match(/#\s*v(\d+)/) || [])[1] || 0);
      if (!m[4]) problems.push(name + ' 未钉到 commit SHA');
      else if (!/#\s*v\d+/.test(l)) problems.push(name + ' 的 SHA 钉定缺版本注释');
      if (major < 5) problems.push(name + ' 主版本偏旧(v' + major + '，会报 Node20 弃用)');
    }
    check('E CI action 钉到 SHA 且版本注释齐全、不低于 v5',
      problems.length === 0 || problems.join(' | '));
  }

  // 版本唯一真源：package.json === test.html 的 CONFIG.toolVersion（写进导出报告）=== package-lock
  {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const inPage = (src['test.html'].match(/toolVersion:\s*'([^']+)'/) || [])[1];
    check('E 版本唯一真源（package.json === CONFIG.toolVersion）',
      inPage === pkg.version || `pkg=${pkg.version} page=${inPage}`);
    check('E package-lock 与 package.json 同步',
      (lock.version === pkg.version && ((lock.packages || {})[''] || {}).version === pkg.version) ||
      `lock=${lock.version}/${((lock.packages || {})[''] || {}).version} pkg=${pkg.version}`);
  }

  // 文档不得与 CI 漂移：README 与 AGENTS.md 都要写全三条命令，README 还要指向 AGENTS.md
  {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const cmds = ['npm test', 'npm run test:smoke', 'npm run test:live'];
    const missReadme = cmds.filter(k => !readme.includes(k)).concat(readme.includes('AGENTS.md') ? [] : ['AGENTS.md']);
    const missAgents = cmds.filter(k => !agents.includes(k));
    check('E README 与 CI 同步（三条命令 + AGENTS.md 指引）', missReadme.length === 0 || '缺: ' + missReadme.join(','));
    check('E AGENTS.md 与 CI 同步（三条命令齐全）', missAgents.length === 0 || '缺: ' + missAgents.join(','));
  }
}

/* ---------------- 汇总 ---------------- */
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail > 0) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
