'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { TextDecoder } = require('util');

const { parseCSV, checkHeadersConsistency, stringifyCSV } = require('./src/csv');
const { validateKeys, buildMerge, resolveAll } = require('./src/merge');
const { buildLedger } = require('./src/ledger');
const { buildHierarchyCheck, validateParentColumn } = require('./src/hierarchy');
const { buildImportOrder } = require('./src/order');
const { buildPlan, validatePlanStructure, applyPlan, cloneDecisions } = require('./src/plan');
const { buildKeyChangeCheck, validateKeyCheckParams } = require('./src/keychange');
const { buildDeterminants, validateDeterminantParams } = require('./src/determinants');
const { RoundStore } = require('./src/rounds');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 3 },
});

const FILE_FIELDS = [
  { name: 'base', maxCount: 1 },
  { name: 'local', maxCount: 1 },
  { name: 'remote', maxCount: 1 },
];

// 本轮上传解析结果 / 合并模型的服务端存储
const roundStore = new RoundStore();

function decorateErrors(label, parseResult) {
  return parseResult.errors.map((e) => ({
    file: label,
    line: e.line,
    message: e.message,
  }));
}

/**
 * 标识无效或已过期时统一返回 404，绝不回退到其他轮数据。
 */
function roundNotFound(res) {
  return res.status(404).json({
    ok: false,
    stage: 'round',
    errors: [
      {
        file: null,
        line: null,
        message: '本轮上传数据不存在或已过期，请重新上传三份 CSV 文件',
      },
    ],
  });
}

/**
 * POST /api/upload
 * multipart: base / local / remote 三个 CSV 文件
 * 服务端保存本轮解析结果并返回 roundId；响应不再携带完整数据，
 * 三份 8 MiB 大文件也不会把合并请求撑过 JSON 体积上限。
 */
app.post('/api/upload', upload.fields(FILE_FIELDS), (req, res) => {
  try {
    const files = req.files || {};
    const missing = ['base', 'local', 'remote'].filter(
      (label) => !files[label] || files[label].length === 0,
    );
    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        stage: 'upload',
        errors: missing.map((label) => ({
          file: label,
          line: null,
          message: '缺少文件',
        })),
      });
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parsed = {};
    const errors = [];

    for (const label of ['base', 'local', 'remote']) {
      const buf = files[label][0].buffer;
      let text;
      try {
        text = decoder.decode(buf);
      } catch (e) {
        errors.push({
          file: label,
          line: null,
          message: '文件不是合法的 UTF-8 编码，请另存为 UTF-8 CSV 后重试',
        });
        continue;
      }
      const result = parseCSV(text);
      parsed[label] = result;
      errors.push(...decorateErrors(label, result));
    }

    if (errors.length > 0) {
      return res.status(400).json({ ok: false, stage: 'parse', errors });
    }

    // 表头一致性
    const headerErrors = checkHeadersConsistency(parsed);
    if (headerErrors.length > 0) {
      return res.status(400).json({ ok: false, stage: 'headers', errors: headerErrors });
    }

    const headers = parsed.base.headers;
    const roundId = roundStore.create(parsed);

    res.json({
      ok: true,
      roundId,
      headers,
      // 三方可作为唯一键的候选列（表头已一致，直接用基准列）
      keyColumns: headers,
      files: {
        base: { line: 1, headers, rowCount: parsed.base.rows.length },
        local: { headers, rowCount: parsed.local.rows.length },
        remote: { headers, rowCount: parsed.remote.rows.length },
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, stage: 'server', errors: [{ file: null, line: null, message: err.message }] });
  }
});

/**
 * POST /api/merge
 * body: { roundId, keyColumn }
 * 从服务端取回本轮解析结果做校验与三方合并，合并模型同样留在服务端，
 * 响应只返回前端展示所需的模型本身。
 */
app.post('/api/merge', (req, res) => {
  try {
    const { roundId, keyColumn } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);

    if (!keyColumn || typeof keyColumn !== 'string') {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [{ file: null, line: null, message: '请求缺少 keyColumn' }],
      });
    }

    const parsed = round.parsed;

    // 服务端再做一次表头一致性校验
    const headerErrors = checkHeadersConsistency(parsed);
    if (headerErrors.length > 0) {
      return res.status(400).json({ ok: false, stage: 'headers', errors: headerErrors });
    }

    const keyErrors = validateKeys(parsed, keyColumn);
    if (keyErrors.length > 0) {
      return res.status(400).json({ ok: false, stage: 'keys', errors: keyErrors });
    }

    const model = buildMerge(parsed, keyColumn);
    round.model = model;
    res.json({ ok: true, roundId, model });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * 规范化请求中的裁决：只保留合法字段，并整体转成无原型对象存储。
 * 唯一键可能是 "__proto__" / "constructor" 等与继承属性重名的合法字符串，
 * 普通 {} 会经 __proto__ 存取器或原型链造成行之间的裁决串扰，因此这里
 * （与 src/plan.js 的套用结果）统一产出 Object.create(null) 容器。
 */
function normalizeDecisions(raw) {
  return cloneDecisions(raw);
}

/**
 * POST /api/export
 * body: { roundId, decisions }
 * 合并模型取自服务端本轮存储，请求体只含冲突决策（体积很小）。
 * 未解决冲突时返回 409；否则返回合并后的 CSV 文本（基准表头顺序）。
 */
app.post('/api/export', (req, res) => {
  try {
    const { roundId, decisions } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);

    const model = round.model;
    if (!model) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [
          { file: null, line: null, message: '本轮尚未完成三方比对，请先选择键列开始比对' },
        ],
      });
    }

    const result = resolveAll(model, normalizeDecisions(decisions));
    if (result.unresolved > 0) {
      return res.status(409).json({
        ok: false,
        stage: 'unresolved',
        unresolved: result.unresolved,
        errors: result.unresolvedDetails.map((message) => ({
          file: null,
          line: null,
          message,
        })),
      });
    }

    const csv = String.fromCharCode(0xfeff) + stringifyCSV([model.headers, ...result.rows]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="merged.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/ledger
 * body: { roundId, decisions }
 * 合并结果来源账本：按最终 CSV 行序逐格记录最终值、取值来源与原文件行号，
 * 删除键单独列出原因。与 /api/export 一样只使用服务端本轮保存的模型与裁决计算
 * （请求体中的任何行数据都会被忽略），且逐格取值与 CSV 导出完全一致。
 * 有未解决冲突时拒绝生成完整账本，返回 409。
 */
app.post('/api/ledger', (req, res) => {
  try {
    const { roundId, decisions } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);

    const model = round.model;
    if (!model) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [
          { file: null, line: null, message: '本轮尚未完成三方比对，请先选择键列开始比对' },
        ],
      });
    }

    const result = buildLedger(model, normalizeDecisions(decisions));
    if (result.unresolved > 0) {
      return res.status(409).json({
        ok: false,
        stage: 'unresolved',
        unresolved: result.unresolved,
        errors: result.unresolvedDetails.map((message) => ({
          file: null,
          line: null,
          message,
        })),
      });
    }

    res.json({ ok: true, roundId, ledger: result.ledger });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/hierarchy
 * body: { roundId, decisions, parentColumn }
 * 合并结果父子层级核验：冲突全部裁决后，按本轮模型与当前裁决算出最终保留行，
 * 以最终唯一键建立索引，核验父键列的缺失父项与循环（仅环上成员）。
 * 父键列必须在表头中且不能是唯一键列（否则 400）；有未解决冲突时拒绝给出
 * 完整结论（409）。核验只提示问题，不改变 CSV 导出。
 */
app.post('/api/hierarchy', (req, res) => {
  try {
    const { roundId, decisions, parentColumn } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);

    const model = round.model;
    if (!model) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [
          { file: null, line: null, message: '本轮尚未完成三方比对，请先选择键列开始比对' },
        ],
      });
    }

    const parentError = validateParentColumn(model, parentColumn);
    if (parentError) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [{ file: null, line: null, message: parentError }],
      });
    }

    const result = buildHierarchyCheck(model, normalizeDecisions(decisions), parentColumn);
    if (result.unresolved > 0) {
      return res.status(409).json({
        ok: false,
        stage: 'unresolved',
        unresolved: result.unresolved,
        errors: result.unresolvedDetails.map((message) => ({
          file: null,
          line: null,
          message,
        })),
      });
    }

    res.json({ ok: true, roundId, check: result.check });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * 模型前置检查：本轮必须已完成三方比对（round.model 存在）。
 * 不满足时统一返回 400；标识无效由调用方先按 404 处理。
 */
function requireModel(res, model) {
  if (model) return true;
  res.status(400).json({
    ok: false,
    stage: 'request',
    errors: [
      { file: null, line: null, message: '本轮尚未完成三方比对，请先选择键列开始比对' },
    ],
  });
  return false;
}

function unresolvedResponse(res, result) {
  return res.status(409).json({
    ok: false,
    stage: 'unresolved',
    unresolved: result.unresolved,
    errors: result.unresolvedDetails.map((message) => ({
      file: null,
      line: null,
      message,
    })),
  });
}

/**
 * POST /api/order
 * body: { roundId, decisions, parentColumn }
 * 父子数据导入顺序：冲突全部裁决后，按本轮模型与当前裁决算出最终保留行，
 * 空父键为根、其余父键按原字符串匹配最终唯一键。存在缺失父项 / 循环时
 * valid=false 并列出问题键与类型；层级有效时按父先子后排序（每步从当前
 * 可输出的行里选原合并 CSV 行序最早者），返回排序后的键序供页面展示。
 * 顺序 CSV 下载见 /api/order/export。
 */
app.post('/api/order', (req, res) => {
  try {
    const { roundId, decisions, parentColumn } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);
    const { model } = round;
    if (!requireModel(res, model)) return;

    const parentError = validateParentColumn(model, parentColumn);
    if (parentError) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [{ file: null, line: null, message: parentError }],
      });
    }

    const result = buildImportOrder(model, normalizeDecisions(decisions), parentColumn);
    if (result.unresolved > 0) return unresolvedResponse(res, result);

    res.json({ ok: true, roundId, order: result.order });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/order/export
 * body: { roundId, decisions, parentColumn }
 * 顺序导出：仅层级有效（无缺失父项、无循环）时返回父先子后的
 * import-order.csv（沿用基准表头与原单元格值，仅行序重排）。
 * 存在缺失父项 / 循环时返回 409 并列出问题键与类型——阻止顺序导出；
 * 原有 /api/export 合并 CSV 导出不受任何影响。
 */
app.post('/api/order/export', (req, res) => {
  try {
    const { roundId, decisions, parentColumn } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);
    const { model } = round;
    if (!requireModel(res, model)) return;

    const parentError = validateParentColumn(model, parentColumn);
    if (parentError) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [{ file: null, line: null, message: parentError }],
      });
    }

    const result = buildImportOrder(model, normalizeDecisions(decisions), parentColumn);
    if (result.unresolved > 0) return unresolvedResponse(res, result);

    if (!result.order.valid) {
      return res.status(409).json({
        ok: false,
        stage: 'hierarchy',
        issueCount: result.order.issueCount,
        errors: result.order.issues.map((it) => ({
          file: null,
          line: null,
          message: `键 "${it.key}"（父键 "${it.parentKey}"）：${it.typeText}`,
        })),
      });
    }

    const csv = String.fromCharCode(0xfeff) + stringifyCSV([model.headers, ...result.rows]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="import-order.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/plan/export
 * body: { roundId, decisions }
 * 跨轮冲突裁决方案导出：只包含已完整裁决（无任何未决冲突）的冲突行。
 * 方案记录唯一键列、表头、该行三方存在状态与各列原值、冲突类型与裁决（含手填值），
 * 不含 roundId、不含原文件行号——重新上传后按内容逐行核对即可复用。
 * 有未解决冲突时返回 409。
 */
app.post('/api/plan/export', (req, res) => {
  try {
    const { roundId, decisions } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);
    const { model } = round;
    if (!requireModel(res, model)) return;

    const result = buildPlan(model, normalizeDecisions(decisions));
    if (result.unresolved > 0) return unresolvedResponse(res, result);

    res.json({ ok: true, roundId, plan: result.plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/plan/import
 * body: { roundId, decisions, plan }
 * 跨轮冲突裁决方案导入：服务端用本轮模型按唯一键逐行核对方案。
 * 键列与表头一致、三方存在状态与原值、冲突类型完全相同时才整行套用；
 * 当前行已有任一裁决时整行跳过。方案结构错误、键列或表头不一致时返回 400，
 * 且在任何套用之前拒绝——不改动任何已有裁决。
 */
app.post('/api/plan/import', (req, res) => {
  try {
    const { roundId, decisions, plan } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);
    const { model } = round;
    if (!requireModel(res, model)) return;

    // 先对照本轮模型检查键列与表头（顺序也必须一致）：不一致时无需再逐行校验结构。
    // 无论哪一类问题都在套用任何裁决之前返回 400，保证不改动任何已有裁决。
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      return res.status(400).json({
        ok: false,
        stage: 'plan',
        errors: [{ file: null, line: null, message: '方案必须是 JSON 对象' }],
      });
    }
    if (plan.keyColumn !== model.keyColumn) {
      return res.status(400).json({
        ok: false,
        stage: 'plan',
        errors: [
          {
            file: null,
            line: null,
            message: `方案的唯一键列 "${plan.keyColumn}" 与本轮 "${model.keyColumn}" 不一致，无法导入`,
          },
        ],
      });
    }
    if (
      !Array.isArray(plan.headers) ||
      plan.headers.length !== model.headers.length ||
      plan.headers.some((h, i) => h !== model.headers[i])
    ) {
      return res.status(400).json({
        ok: false,
        stage: 'plan',
        errors: [
          {
            file: null,
            line: null,
            message: '方案表头与本轮不一致（列名、列数或顺序不同），无法导入',
          },
        ],
      });
    }

    const structureError = validatePlanStructure(plan);
    if (structureError) {
      return res.status(400).json({
        ok: false,
        stage: 'plan',
        errors: [{ file: null, line: null, message: structureError }],
      });
    }

    const result = applyPlan(model, normalizeDecisions(decisions), plan);
    res.json({ ok: true, roundId, decisions: result.decisions, report: result.report });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/keycheck
 * body: { roundId, decisions, columns, maxDiff }
 * 疑似唯一键变更核对：冲突全部裁决后，从本轮基准与最终结果提取消失键 / 新增键
 * （两组各限 12 个，任一组超限返回 409 stage=limit 并给出两组数量），
 * 按用户选择的非键比较列逐格按原字符串比较，以不同格数为代价、差异上限为
 * 0 至比较列数的整数，求允许交叉的一对一配对（先配对数最多、再总代价最小），
 * 并对每个旧键列出所有最优方案中可能对应的新键与是否可能未配对。
 * 核对只读：不改动模型、数据与任何裁决。有未决冲突时返回 409。
 */
app.post('/api/keycheck', (req, res) => {
  try {
    const { roundId, decisions, columns, maxDiff } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);
    const { model } = round;
    if (!requireModel(res, model)) return;

    const paramError = validateKeyCheckParams(model, columns, maxDiff);
    if (paramError) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [{ file: null, line: null, message: paramError }],
      });
    }

    const result = buildKeyChangeCheck(model, normalizeDecisions(decisions), columns, maxDiff);
    if (result.unresolved > 0) return unresolvedResponse(res, result);

    if (result.limitExceeded) {
      const le = result.limitExceeded;
      return res.status(409).json({
        ok: false,
        stage: 'limit',
        limit: le.limit,
        oldCount: le.oldCount,
        newCount: le.newCount,
        errors: [
          {
            file: null,
            line: null,
            message: `消失键 ${le.oldCount} 个、新增键 ${le.newCount} 个，超过每组 ${le.limit} 个的上限，无法进行疑似唯一键变更核对`,
          },
        ],
      });
    }

    res.json({ ok: true, roundId, check: result.check });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

/**
 * POST /api/determinants
 * body: { roundId, decisions, targetColumn, candidateColumns }
 * 最小决定列发现：冲突全部裁决后，从本轮模型与当前裁决取得最终保留行（最多 300 行，
 * 超限返回 409 stage=limit），按原字符串比较（空串也是值）枚举所有"成立且任何真子集
 * 均不成立"的候选列组合；目标恒定时仅返回空组合；无行时提示无数据。每个非空组合
 * 逐列移除并附一对证明失效的行键及目标值；一个成立组合都没有时给出全候选列相同而
 * 目标不同的反例（行对按最终行序取字典序最早者）。发现只读，不改动任何数据与裁决。
 */
app.post('/api/determinants', (req, res) => {
  try {
    const { roundId, decisions, targetColumn, candidateColumns } = req.body || {};
    const round = roundStore.get(roundId);
    if (!round) return roundNotFound(res);
    const { model } = round;
    if (!requireModel(res, model)) return;

    const paramError = validateDeterminantParams(model, targetColumn, candidateColumns);
    if (paramError) {
      return res.status(400).json({
        ok: false,
        stage: 'request',
        errors: [{ file: null, line: null, message: paramError }],
      });
    }

    const result = buildDeterminants(
      model,
      normalizeDecisions(decisions),
      targetColumn,
      candidateColumns,
    );
    if (result.unresolved > 0) return unresolvedResponse(res, result);

    if (result.limitExceeded) {
      const le = result.limitExceeded;
      return res.status(409).json({
        ok: false,
        stage: 'limit',
        limit: le.limit,
        rowCount: le.rowCount,
        errors: [
          {
            file: null,
            line: null,
            message: `最终保留行 ${le.rowCount} 行，超过最多 ${le.limit} 行的上限，无法进行最小决定列发现`,
          },
        ],
      });
    }

    res.json({ ok: true, roundId, analysis: result.analysis, emptyData: !!result.emptyData });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      stage: 'server',
      errors: [{ file: null, line: null, message: err.message }],
    });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// multer / body-parser 触发的体积上限与请求体解析错误：统一成 JSON 错误信封，
// 避免默认错误处理器向客户端输出 HTML 堆栈页。
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE')) {
    return res.status(413).json({
      ok: false,
      stage: 'request',
      errors: [
        {
          file: err.field || err.fieldname || null,
          line: null,
          message:
            err.code === 'LIMIT_FILE_SIZE'
              ? '单个文件超过 20 MiB 上限'
              : '请求体超过 20 MiB 上限；请重新上传并通过本轮标识继续操作',
        },
      ],
    });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'charset.unsupported')) {
    return res.status(400).json({
      ok: false,
      stage: 'request',
      errors: [{ file: null, line: null, message: '请求体不是合法的 JSON' }],
    });
  }
  console.error(err);
  res.status(500).json({
    ok: false,
    stage: 'server',
    errors: [{ file: null, line: null, message: (err && err.message) || '服务器内部错误' }],
  });
});

function start(port = PORT) {
  return app.listen(port, () => {
    console.log(`CSV 三方合并工具已启动: http://localhost:${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, roundStore, start };
