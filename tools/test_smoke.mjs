#!/usr/bin/env node
/**
 * test_smoke.mjs —— 真实浏览器冒烟测试（Playwright + Chromium）
 *
 * 用法：npm run test:smoke   （需先 npx playwright install chromium）
 *
 * 覆盖 test_scoring.mjs 的 DOM 桩覆盖不到的部分：
 *   真实 CSS 布局（窄屏雷达图标签不被裁切）、canvas 导出、打印报告可见性、
 *   localStorage 续答、点击热区实际尺寸、题本 CSV 真实 fetch。
 * 逻辑分支（计分/校验/回退）仍由 test_scoring.mjs 负责，这里不重复。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
  try {
    const buf = await readFile(path.join(root, rel));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    // 模拟 GitHub Pages：任意缺失路径都回落到 404.html（状态码仍 404），
    // 这样 404 页里的旧地址重定向脚本才能被真实测到。
    try {
      const buf = await readFile(path.join(root, '404.html'));
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  // 同 test_scoring：断言体可能返回字符串说明失败原因，字符串是 truthy，须显式排除
  const ok = typeof cond === 'string' ? false : !!cond;
  if (ok) pass++;
  else {
    const why = typeof cond === 'string' ? cond : extra;
    fail++; failures.push(name + (why ? ' :: ' + why : ''));
    console.error('  FAIL: ' + name + (why ? ' :: ' + why : ''));
  }
}
function section(t) { console.log('— ' + t); }

const browser = await chromium.launch();

/** 起一个页面，收集控制台错误与页面异常 */
async function newPage(ctxOpts = {}) {
  // acceptDownloads：重定向到 .csv 时 Chromium 会按下载处理，
  // 不接受下载会让该导航被丢弃、页面停在原地址。
  const ctx = await browser.newContext({ acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  return { ctx, page, errors };
}

/**
 * 用 dev 后门直接生成结果页，避免点 100 题。
 * 注意：内联脚本里的顶层 let/function 不挂在 window 上（经典脚本语义），
 * 所以必须用 page.evaluate 的函数形式在同词域求值，不能写 window.xxx。
 */
async function toResult(page, mode = 'gradient') {
  await page.evaluate(m => devShowResult(m), mode);
  await page.waitForSelector('#result.active');
}

try {
  /* ---------------- 1. 落地页 ---------------- */
  {
    section('1: 落地页');
    const { ctx, page, errors } = await newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });

    check('S1 标题正确', (await page.title()).includes('HEXACO'));
    const cta = page.locator('a.cta');
    check('S2 CTA 指向 test.html', await cta.getAttribute('href') === 'test.html');
    check('S3 有 favicon', !!(await page.locator('link[rel="icon"]').count()));
    check('S4 有 og:title', !!(await page.locator('meta[property="og:title"]').count()));

    await cta.click();
    await page.waitForURL(/test\.html/);
    check('S5 CTA 可点达测试页', page.url().includes('test.html'));
    check('S6 落地页无 JS 错误', errors.length === 0 || errors.join(' | '));
    await ctx.close();
  }

  /* ---------------- 2. 题本从同目录 CSV 加载 ---------------- */
  {
    section('2: 题本加载');
    const { ctx, page, errors } = await newPage();
    await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
    const src = await page.getAttribute('html', 'data-items-source');
    check('S7 题本来源=csv', src === 'csv' || 'got ' + src);
    // 页面无 window.N_ITEMS（经典脚本词域），改用欢迎页渲染出的题量断言
    check('S8 题量 100', (await page.textContent('#welcomeCount')).trim() === '100');
    check('S9 无 JS 错误', errors.length === 0 || errors.join(' | '));
    await ctx.close();
  }

  /* ---------------- 3. 完整答题流程（真实点击） ---------------- */
  {
    section('3: 答题流程');
    const { ctx, page, errors } = await newPage({ viewport: { width: 390, height: 780 } });
    await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
    await page.click('#startBtn');
    await page.waitForSelector('#test.active');

    check('S10 进入答题页', await page.locator('#test.active').count() === 1);
    check('S11 首页渲染 5 题', await page.locator('#questionList .question').count() === 5);

    // 点击热区实际尺寸（P0 修过：30px → 44px）
    const box = await page.locator('#questionList .question').first().locator('.dot').first().boundingBox();
    check('S12 点击热区 ≥ 40px', box && box.width >= 40 && box.height >= 40,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box');

    // 点第一题第 4 个选项
    await page.locator('#questionList .question').first().locator('.dot').nth(3).click();
    // 点击生效：用 DOM 状态判断（radio 选中 + 题目高亮），不依赖内部变量
    const firstQ = page.locator('#questionList .question').first();
    await page.waitForFunction(() => {
      const q = document.querySelector('#questionList .question');
      return q && q.classList.contains('answered') &&
        q.querySelector('input:checked') && q.querySelector('input:checked').value === '4';
    });
    check('S13 点击生效并选中第 4 项', true);
    check('S14 进度条更新', (await page.textContent('#answeredCount')).trim() === '1');

    // 键盘数字键作答 + 焦点移动（P0 修过）
    await page.keyboard.press('2');
    const focused = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a.type === 'radio' ? { idx: a.closest('.question').dataset.idx, val: a.value } : null;
    });
    check('S15 数字键作答且焦点移动', !!focused && focused.val === '2', JSON.stringify(focused));

    // localStorage 落盘
    const saved = await page.evaluate(() => localStorage.getItem('hexaco_progress_v1'));
    check('S16 进度已存 localStorage', !!saved && JSON.parse(saved).answers[0] === 4);
    check('S17 答题无 JS 错误', errors.length === 0 || errors.join(' | '));
    await ctx.close();
  }

  /* ---------------- 4. 结果页与窄屏雷达图 ---------------- */
  {
    section('4: 结果页 / 窄屏雷达图');
    for (const vw of [320, 390]) {
      const { ctx, page, errors } = await newPage({ viewport: { width: vw, height: 780 } });
      await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
      await toResult(page);

      const svg = page.locator('#radarMount svg');
      check(`S18[${vw}] 雷达图已渲染`, await svg.count() === 1);

      // 标签必须完整落在 svg 元素内（viewBox 留白的真实效果）
      const overflow = await page.evaluate(() => {
        const s = document.querySelector('#radarMount svg');
        if (!s) return 'no svg';
        const sr = s.getBoundingClientRect();
        const bad = [];
        s.querySelectorAll('text').forEach(t => {
          const r = t.getBoundingClientRect();
          if (r.left < sr.left - 0.5 || r.right > sr.right + 0.5 ||
              r.top < sr.top - 0.5 || r.bottom > sr.bottom + 0.5) {
            bad.push(`${t.textContent}@${Math.round(r.left)}-${Math.round(r.right)}`);
          }
        });
        return bad;
      });
      check(`S19[${vw}] 雷达标签未被裁切`, Array.isArray(overflow) && overflow.length === 0,
        Array.isArray(overflow) ? overflow.join(',') : String(overflow));

      // 标签字号：SVG 内 CSS px 不随 viewBox 缩放，任何视口下都应是 12px。
      // （曾误以为窄屏会缩到 9px —— 那是把 viewBox 缩放套到了 CSS px 上。）
      const fs = await page.evaluate(() => {
        const t = document.querySelector('#radarMount svg text');
        return t ? parseFloat(getComputedStyle(t).fontSize) : 0;
      });
      check(`S20[${vw}] 标签字号恒为 12px`, fs === 12, 'fontSize=' + fs);

      // 六大领域 + 利他主义都在页面上
      check(`S21[${vw}] 六个领域卡片`, await page.locator('#detailsMount .card, #detailsMount > *').count() >= 6);
      check(`S22[${vw}] 利他主义卡片`, (await page.textContent('#altruismMount')).includes('利他主义'));

      // 打印报告已预填充（Ctrl+P 修复）
      const pr = await page.evaluate(() => document.getElementById('printReport').innerHTML);
      check(`S23[${vw}] 打印报告已预填充`, pr.includes('HEXACO 人格测试报告'));

      check(`S24[${vw}] 结果页无 JS 错误`, errors.length === 0 || errors.join(' | '));
      await ctx.close();
    }
  }

  /* ---------------- 5. PNG 导出 ---------------- */
  {
    section('5: PNG 导出');
    const { ctx, page, errors } = await newPage();
    await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
    await toResult(page);

    const png = await page.evaluate(() => {
      const cv = window.drawOverviewCard();
      const url = cv.toDataURL('image/png');
      return { len: url.length, head: url.slice(0, 22), w: cv.width, h: cv.height };
    });
    check('S25 PNG dataURL 有效', png.head === 'data:image/png;base64,' && png.len > 5000, JSON.stringify(png).slice(0, 90));
    check('S26 画布尺寸合理', png.w >= 1200 && png.h >= 800, `${png.w}x${png.h}`);

    // 真实点击导出按钮：触发下载且不报错
    const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.click('#saveImageBtn');
    const download = await dl;
    check('S27 导出按钮触发下载', !!download, 'no download event');
    if (download) check('S28 下载文件名含 HEXACO', (download.suggestedFilename() || '').includes('HEXACO'), download.suggestedFilename());
    check('S29 导出无 JS 错误', errors.length === 0 || errors.join(' | '));
    await ctx.close();
  }

  /* ---------------- 6. 返回修改 / 重新测试 ---------------- */
  {
    section('6: 返回修改 / 重新测试');
    const { ctx, page, errors } = await newPage();
    await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
    await toResult(page, 'high');

    await page.click('#editBtn');
    await page.waitForSelector('#test.active');
    check('S30 返回修改进入答题屏', await page.locator('#test.active').count() === 1);
    const kept = await page.evaluate(() =>
      document.querySelectorAll('#questionList .question.answered').length);
    check('S31 返回修改保留作答（当前页 5 题仍高亮）', kept === 5, 'answered=' + kept);
    // 全部作答保留：重新提交应直接进结果页而非提示未答完
    await page.evaluate(() => { page = TOTAL_PAGES - 1; renderPage(); });
    await page.click('#nextBtn');
    await page.waitForSelector('#result.active');
    check('S31b 全部作答未丢失（可直接出结果）', await page.locator('#result.active').count() === 1);

    await page.click('#restartBtn');
    await page.waitForSelector('#welcome.active');
    const cleared = await page.evaluate(() => localStorage.getItem('hexaco_progress_v1'));
    check('S32 重新测试清空进度', cleared === null, String(cleared).slice(0, 40));
    check('S33 无 JS 错误', errors.length === 0 || errors.join(' | '));
    await ctx.close();
  }

  /* ---------------- 7. 续答（跨会话） ---------------- */
  {
    section('7: 续答');
    const { ctx, page } = await newPage();
    await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const a = new Array(100).fill(0);
      for (let i = 0; i < 30; i++) a[i] = 3;
      localStorage.setItem('hexaco_progress_v1', JSON.stringify({ answers: a, page: 5, meta: { sessions: 1 } }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    const note = await page.textContent('#resumeNote');
    check('S34 显示续答提示', note.includes('30'), note.trim().slice(0, 40));
    check('S35 提供继续测试按钮', await page.locator('#resumeBtn').count() === 1);

    await page.click('#resumeBtn');
    await page.waitForSelector('#test.active');
    check('S36 续答恢复到上次页', await page.evaluate(() =>
      document.getElementById('pageLabel').textContent.includes('6')),
    await page.textContent('#pageLabel'));
    await ctx.close();
  }

  /* ---------------- 8. 主题切换 ---------------- */
  {
    section('8: 主题');
    const { ctx, page } = await newPage();
    await page.goto(base + '/test.html', { waitUntil: 'networkidle' });
    const before = await page.getAttribute('html', 'data-theme');
    await page.click('#themeToggle');
    const after = await page.getAttribute('html', 'data-theme');
    check('S37 主题可切换', before !== after, `${before} -> ${after}`);
    check('S38 主题已持久化', await page.evaluate(() => localStorage.getItem('hexaco_theme')) === after);
    await ctx.close();
  }

  /* ---------------- 9. 404 页与旧地址重定向 ---------------- */
  {
    section('9: 404 / 旧地址重定向');
    {
      const { ctx, page } = await newPage();
      // 静态服务器直接命中 404.html 文件本身，返回 200；
      // 线上 Pages 会返回 404 状态码 —— 内容一致，这里只断言内容。
      await page.goto(base + '/404.html');
      check('S39 404 页可渲染', (await page.textContent('h1')).includes('不存在'));
      check('S40 404 有返回入口', await page.locator('a.btn').count() >= 2);
      await ctx.close();
    }
    // 旧版主文件（中文文件名）应被重定向到 test.html。
    // 重定向由脚本触发，会中断原始导航导致 goto 超时，故不 await goto，只等目标 URL。
    {
      const { ctx, page } = await newPage();
      const wait = page.waitForURL('**/test.html', { timeout: 8000 }).then(() => true).catch(() => false);
      await page.goto(base + '/HEXACO%E6%B5%8B%E8%AF%95_v1.0.2.html', { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
      check('S41 旧版主文件 → test.html', await wait, 'got ' + new URL(page.url()).pathname);
      await ctx.close();
    }
    // 下载而非渲染，所以断言「下载到的文件名已是新名」，而不是断言页面跳转。
    {
      const { ctx, page } = await newPage();
      const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
      await page.goto(base + '/HEXACO_items.csv', { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
      const d = await dl;
      check('S41b 旧题本名重定向后下载到新文件', !!d && d.suggestedFilename() === 'items.csv',
        d ? 'got ' + d.suggestedFilename() : 'no download');
      await ctx.close();
    }
    // 真正不存在的地址不应被重定向，且应回显路径
    {
      const { ctx, page } = await newPage();
      await page.goto(base + '/no-such-page', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      const got = new URL(page.url()).pathname;
      check('S42 未知地址不被重定向', got === '/no-such-page', 'got ' + got);
      check('S43 未知地址回显路径', (await page.textContent('#msg')).includes('no-such-page'));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail > 0) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');