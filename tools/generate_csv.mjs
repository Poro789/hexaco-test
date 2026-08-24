#!/usr/bin/env node
/**
 * generate_csv.mjs —— 从 HTML 内置题本重新生成 HEXACO_items.csv
 *
 * 用法：node tools/generate_csv.mjs
 *
 * 何时需要运行：修改了 HTML 里的内置题本（questions / scoringKeys /
 * 反向计分列表）之后，运行本脚本把内置数据重新导出为 CSV，保持两者一致。
 * 平时改题本应直接编辑 HEXACO_items.csv（用 Excel 打开即可），无需运行本脚本。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'HEXACO测试_v1.0.2.html');
const csvPath = path.join(root, 'HEXACO_items.csv');

const html = readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 <script> 块'); process.exit(1); }
const code = m[1];

// 截取纯数据段（题目 + 评分键 + 中文标签），无 DOM 依赖，可直接求值
const start = code.indexOf('let questions = [');
const marker = code.indexOf('CONFIG —— 模板化参数区');
const end = marker > 0 ? code.lastIndexOf('/*', marker) : -1; // 截到 CONFIG 注释块之前
if (start < 0 || end < 0) { console.error('未定位到数据段'); process.exit(1); }
const dataCode = code.slice(start, end) + '\nglobalThis.__bank = { questions, scoringKeys, reverseScoredItems, reverseSet, altruismItems, itemFactor, factorZh, facetZh, FACTOR_ORDER, FACET_ORDER };';

const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(dataCode, sandbox, { filename: 'builtin-data.js' });
const { questions, scoringKeys, reverseScoredItems, reverseSet, factorZh, facetZh, FACTOR_ORDER, FACET_ORDER } = sandbox.__bank;

// 题号 -> (领域, 侧面)
function locate(num) {
  for (const f of FACTOR_ORDER) {
    for (const fa of FACET_ORDER[f]) {
      if (scoringKeys[f][fa].includes(num)) return [factorZh[f], facetZh[fa]];
    }
  }
  return ['利他主义', '利他主义'];
}

function esc(s) {
  s = String(s).replace(/\r?\n/g, ' ');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const rows = ['题号,题目,领域,侧面,反向计分'];
for (let i = 1; i <= questions.length; i++) {
  const [domain, facet] = locate(i);
  rows.push([i, esc(questions[i - 1]), esc(domain), esc(facet), reverseSet.has(i) ? 1 : 0].join(','));
}
if (rows.length - 1 !== 100) { console.error('题量应为 100，实际 ' + (rows.length - 1)); process.exit(1); }

// UTF-8 带 BOM + CRLF：Excel 直接打开不乱码
writeFileSync(csvPath, '\uFEFF' + rows.join('\r\n') + '\r\n', 'utf8');
console.log('已生成 ' + path.relative(root, csvPath) + '（' + (rows.length - 1) + ' 题，反向计分 ' + reverseScoredItems.length + ' 题）');
