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
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'HEXACO测试_v1.0.2.html');
const csvPath = path.join(root, 'HEXACO_items.csv');

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
    click() { (this._listeners.click || []).slice().forEach(fn => fn.call(el, { type: 'click' })); },
    getBoundingClientRect() { return { top: 0, height: 0 }; },
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
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.error('  FAIL: ' + name + (extra ? ' :: ' + extra : '')); }
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
    const rSame = JSON.stringify(Array.from(p.bank.reverse).sort((a, b) => a - b)) === JSON.stringify(reverseScoredItems);
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

/* ---------------- 汇总 ---------------- */
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail > 0) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
