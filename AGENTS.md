# AGENTS.md — 在这个仓库里工作时必须遵守的规则

HEXACO-PI-R 100 题纯前端人格测试，GitHub Pages 发布（站点根固定为 `/hexaco-test/`）。
取舍标准（用户 2026-10-08 明确，已移除「零构建零依赖」「总量 ≤1GB」两条教条）：
① 本地 AI 能把项目改好（可验证、能定位、改完不会静默坏）；② Pages 快速、免费、零费用地发布。

## 改完必须跑，两条都要绿（CI 门禁就是这两条，不绿就不部署）

```powershell
npm test            # tools/test_scoring.mjs：无浏览器逻辑自测（计分 / CSV / 回退 / 页面元数据 / CI 清单），65 项
npm run test:smoke  # tools/test_smoke.mjs：Playwright + Chromium 真实浏览器冒烟（布局 / 导出 / localStorage / 404 重定向），52 项
```

首次跑冒烟需 `npx playwright install chromium`。页面运行期零第三方脚本，Playwright 只在 devDependencies。
临时脚本和截图放 `test-results/`（已 gitignore，不会上线）。

## 不可破坏的约定

1. **题本唯一真源是 `test.html` 里的内置数据**（`questions` / `scoringKeys` / `reverseScoredItems` / `N_ITEMS`）。
   `items.csv` 是它的导出物：改了内置数据必须跑 `npm run gen:csv` 并把 CSV 一起提交，否则两边漂移。
   结构被 CSV 校验锁定，不要试图放宽：恰好 100 题、题号 1–100 不重不漏、六域各 4 侧面 × 每侧面 4 题、
   利他主义 4 题（97–100，居间量表，不计入六域分）、50 个反向计分项（6−x）。
2. **版本只有一个真源**：`package.json` 的 `version` 必须等于 `test.html` 里的 `CONFIG.toolVersion`
   ——后者会写进用户导出的 PDF/PNG 报告，不一致就查不出用户拿的是哪版题本。`test_scoring.mjs` E 段断言这件事。
   改版本的完整动作：改这两处 → `npm install`（刷新 package-lock，E 段也断言它同步）→ 提交 → 打 tag。
3. **发布清单是显式的**：新要上线的文件必须加进 `.github/workflows/pages.yml` 里 `cp … _site/` 那一行；
   两个 `.doc` 原始材料永远不进线上目录。E 段会检查清单里每个文件都存在。
4. **push 到 main = 当场发布**。没得到用户明确同意不要 push，本地提交即可；发布用 tag（vX.Y.Z）。
5. 改了阈值或校验规则，要同步改 `test_scoring.mjs` / `test_smoke.mjs` 的断言——不能只改页面让测试变绿。
6. 任何外部来源文本（题干、领域名、侧面名）写进 DOM 前必须过 `escapeHtml()`（见 test.html 的转义段），
   因为 README 让用户用 Excel 直接编辑 `items.csv`，题干里出现 `<` 或 `&` 会破坏渲染。

## 已知坑

- 欢迎页顶部那行仪器名小字（`#brandMark`）**连点 5 次** = dev 面板（或地址栏加 `#dev`）。改这段文案要同步 README。
- 配色 token 有三份（`index.html` / `test.html` / `404.html`），改一处必须同步三处。
  小字对比度硬底线 ≥4.5:1：当前 `--faint` 浅色 `#71716a`、暗色 `#8a8a82`；六维色只用于图表，不作为文字色。
  test.html 用 `data-theme` + localStorage 持久化，index/404 只跟随 `prefers-color-scheme`（无脚本）。
- 窄屏雷达图标签会被裁切（S19/S20 用真实布局守着）：不要改成缩小字号来「修」。
- 本地预览：`python -m http.server 8123`。直接双击打开（`file://`）时 fetch 不到 `items.csv`，
  会静默走内置兜底并显示 `data-items-source="builtin"`——这是预期行为，不是 bug。
- CI 里 deploy 需要 `pages: write` + `id-token: write`；test/smoke 两个 job 只该有 `contents: read`。
