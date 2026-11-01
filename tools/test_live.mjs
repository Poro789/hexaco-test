// 线上核验：确认 Pages 上的内容真的等于仓库里已提交的那一份。
// 用途：发布后（push main 之后）跑一次，抓的是「改了但没上线」「上线了旧版本」「漏发文件」这类问题。
//
//   node tools/test_live.mjs [基准URL]        # 默认 https://poro789.github.io/hexaco-test/
//
// 判定方式不是比对色值或文案（那种断言会随改动过时），而是逐字节比对：
// 期望值取 `git show HEAD:<文件>` 的 blob 字节（= CI 检出的那份），线上取 HTTP 响应体。
// 发布清单从 .github/workflows/pages.yml 的 `cp … _site/` 那行读，与部署同一份清单，不会漂移。
// Pages 生效有几秒到几十秒的延迟，所以整体重试，最多 --tries 次。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) || 'https://poro789.github.io/hexaco-test/').replace(/\/?$/, '/');
const tries = Number((args.find(a => a.startsWith('--tries=')) || '--tries=6').split('=')[1]);
const waitMs = 15000;

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
// 用 git 而不是工作树：Windows 上 autocrlf 会让工作树文件多个 \r，与 CI 检出的字节不一致
const blob = (p) => execFileSync('git', ['show', 'HEAD:' + p], { cwd: root, maxBuffer: 8 << 20 });

const yml = readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
const manifest = ((yml.match(/cp ([^\n]+) _site\//) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
if (manifest.length === 0) {
  console.error('FAIL  读不到 pages.yml 的发布清单（cp … _site/）');
  process.exit(1);
}

let pass = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; return; }
  failures.push(name + (detail ? ' :: ' + detail : ''));
};

// 版本：期望值取 package.json（版本唯一真源），线上取 test.html 里的 CONFIG.toolVersion
const wantVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

async function verifyAll() {
  const bad = [];
  const notes = [];
  for (const p of manifest) {
    let body;
    try {
      const res = await fetch(base + p, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (!res.ok) { bad.push(p + ' HTTP ' + res.status); continue; }
      body = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      bad.push(p + ' 请求失败 ' + e.message);
      continue;
    }
    const want = blob(p);
    if (!want.equals(body)) {
      bad.push(p + ' 内容不一致（仓库 ' + want.length + 'B/' + sha(want) +
        '，线上 ' + body.length + 'B/' + sha(body) + '）');
    } else {
      notes.push(p + ' ' + body.length + 'B ' + sha(body));
    }
  }
  // 版本串必须已经在线上（防止逐字节相同但仍是旧提交那次部署）
  const live = await fetch(base + 'test.html', { cache: 'no-store' }).then(r => r.text()).catch(() => '');
  const found = (live.match(/toolVersion:\s*'([^']+)'/) || [])[1];
  if (found !== wantVersion) bad.push('线上 toolVersion=' + found + '，期望 ' + wantVersion);
  return { bad, notes, found };
}

let last;
for (let i = 1; i <= tries; i++) {
  last = await verifyAll();
  if (last.bad.length === 0) break;
  if (i < tries) {
    console.log('第 ' + i + ' 次未通过（' + last.bad.join('；') + '），' + waitMs / 1000 + 's 后重试…');
    await new Promise(r => setTimeout(r, waitMs));
  }
}

for (const n of last.notes) console.log('OK    ' + n);
check('线上每个发布文件与 HEAD 逐字节一致（清单 ' + manifest.length + ' 个：' + manifest.join(' ') + '）',
  last.bad.length === 0, last.bad.join('；'));
check('线上 toolVersion 等于 package.json 的 ' + wantVersion, last.found === wantVersion, '实际 ' + last.found);

console.log('\n结果：' + pass + ' 通过，' + failures.length + ' 失败（基准 ' + base + '）');
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
