# HEXACO 人格测试（100 题 · 单文件离线工具）

基于 HEXACO-PI-R 100 题自评量表的纯前端评分工具：单 HTML 文件、零外部依赖、完全离线，
数据只保存在本机浏览器（localStorage），不出内网。

## 文件说明

| 文件 | 说明 |
|---|---|
| `index.html` | GitHub Pages 落地页（[线上版入口](https://poro789.github.io/hexaco-test/)，双击也能用） |
| `HEXACO测试_v1.0.2.html` | 全部功能（答题、计分、雷达图、PDF/PNG 导出、dev 模式） |
| `HEXACO_items.csv` | **外部题本**（100 题 + 评分结构），日常维护改这个文件 |
| `Chinese_self100_simplified.doc` / `English_self100.doc` | 参照题本（原始材料，勿用于计分） |
| `.github/workflows/pages.yml` | GitHub Pages 自动部署（push 到 main 即发布线上版） |
| `tools/generate_csv.mjs` | 从 HTML 内置数据重新生成 CSV |
| `tools/test_scoring.mjs` | 无浏览器逻辑自测（计分 / CSV / 流程） |

## 使用方法

**方式零：线上版（GitHub Pages）**
<https://poro789.github.io/hexaco-test/> —— 仓库 `main` 分支根目录直接发布，题本 CSV 同目录可加载；无需下载即可作答。

**方式一：双击 HTML（file://）**
直接可用，使用内置题本（与 `HEXACO_items.csv` 内容一致）。

**方式二：本地起个静态服务（可加载外部 CSV，推荐）**
```powershell
cd <仓库根目录>          # 包含 HTML 与 HEXACO_items.csv 的目录
python -m http.server 8123
# 浏览器打开 http://127.0.0.1:8123/HEXACO测试_v1.0.2.html
```

页面会按以下优先级确定题本，任何一级失败都安全回退到下一级：
1. **同目录 CSV**（`HEXACO_items.csv`，仅 http 方式下生效；可用 `CONFIG.itemsCsv` 改文件名）
2. **dev 导入的题本**（localStorage，file:// 下也生效，见下文 dev 模式）
3. **内置题本**（HTML 内快照，兜底）

页脚/dev 面板会显示当前题本来源（`<html>` 上也有 `data-items-source="csv|local|builtin"` 属性，便于脚本检查）。

## 题本 CSV 维护

`HEXACO_items.csv`：UTF-8 带 BOM、CRLF，Excel 可直接打开编辑。

| 列 | 含义 | 取值 |
|---|---|---|
| 题号 | 1–100，每号恰好一行 | 整数 |
| 题目 | 题干文本 | 非空 |
| 领域 | 六域 + 利他主义 | 中文（诚实-谦逊/情绪性/外向性/宜人性/尽责性/经验开放性/利他主义）或英文名均可 |
| 侧面 | 该领域下的侧面 | 中文（如 宽恕性）或英文名（如 Forgiveness） |
| 反向计分 | 是否反向计分（6−x） | 0 或 1 |

保存后刷新页面即生效。CSV 通过校验前，页面**不会**应用它，而是提示错误并回退，
所以改错也不会导致页面打不开。校验规则：表头一致、恰好 100 行、题号 1–100 不重不漏、
六个领域各 4 侧面 × 每侧面 4 题、利他主义 4 题。

> 注意：改题本只改变**题目文本与评分归属**；24 侧面 / 6 领域 / 100 题的结构是
> HEXACO-100 的固定结构，被校验锁定，防止改错计分键。

## 评分依据

- 题目顺序、评分键（24 侧面 × 4 题）、50 个反向计分项、利他主义 4 题
  （97–100，居间量表，不计入六大领域分）与官方 HEXACO-PI-R 评分手册逐位一致。
- 各量表得分 = 题目作答均值（1–5），反向题按 6−x 折算。
- 结果为原始分，**未换算常模**；相对位置参考
  Lee & Ashton (2018, *Assessment* 25(5)) 描述统计自行计算（报告中已注明该参照为英语样本，非中国常模）。

## Dev 模式（QA 用，真实用户不可见）

入口：欢迎页顶部小字（HEXACO · PI-R）**连点 5 次**，或地址栏加 `#dev`。

| 按钮 | 作用 |
|---|---|
| 梯度 / 正态 / 随机 / 全5 / 全1 | 直接生成结果页，核对雷达轴↔维度↔颜色↔数值 |
| 末页 | 只答前 95 题停在末页，核对“还有 N 题未完成”校验 |
| 导入题本 CSV… | 读取本地 CSV 并保存（file:// 下换题本的唯一途径） |
| 恢复内置题本 | 清除本地导入的题本并刷新 |

## 自检

```powershell
node tools/test_scoring.mjs     # 38 项逻辑自测（需 Node 18+）
node tools/generate_csv.mjs     # 内置数据 → CSV（仅当改了 HTML 内置题本后）
```

## 数据与隐私

- 作答进度、主题、dev 导入的题本存于 localStorage（键前缀 `hexaco_`）；“重新开始”会清空进度。
- 施测计时只累计答题屏的活跃时间（切走页面暂停，单次间隔 120 秒封顶并记一次中断），
  供结果导出中的质量旗标使用。
- 本工具不能替代专业心理评估。

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。
