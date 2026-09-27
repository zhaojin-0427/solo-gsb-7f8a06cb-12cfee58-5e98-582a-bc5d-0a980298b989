'use strict';

/**
 * 跨轮冲突裁决方案（conflict resolution plan）。
 *
 * 当前比对中，用户可把已完整裁决的冲突行下载为 JSON 方案；重新上传并比对后，
 * 再把方案导入新一轮。方案本身不含任何轮次标识（roundId），也不含原文件行号：
 * 服务端只用本轮重新算出的模型，按唯一键逐行核对——
 *
 *   - 方案记录的唯一键列、表头必须与本轮完全一致（顺序也一致）；
 *   - 该行基准 / 本地 / 远端的存在状态、三方各列原值完全相同；
 *   - 冲突类型（行级冲突 + 各冲突列）完全相同；
 *
 * 全部相同时才整行套用方案中的裁决（含手填值）。行序与原文件行号变化不影响匹配。
 * 当前行已有任一裁决时整行跳过，保留人工操作；格式错误不会改动任何裁决。
 *
 * 方案 JSON 结构（version 1）：
 *   {
 *     kind, version, generatedAt, keyColumn, headers,
 *     rows: [{
 *       key,
 *       presence: { base, local, remote },          // 三方行是否存在
 *       values:   { base: string[]|null, ... },      // 存在方的各列原值，否则 null
 *       conflicts: { row: <行级冲突类型>|null, cells: number[] }, // cells 为列下标
 *       decision:  { row: 'keep'|'delete'|null,
 *                    cells: [{ column: <列下标>, choice, value? }] },
 *     }]
 *   }
 */

const { resolveRowProvenance, ownProp, keyedMap } = require('./merge');

const PLAN_KIND = 'csv-3way-merge-conflict-plan';
const PLAN_VERSION = 1;

const SIDES = ['base', 'local', 'remote'];
const ROW_CONFLICT_TYPES = new Set(['row-delete-modify', 'row-add-divergent']);
const ROW_DECISIONS = new Set(['keep', 'delete']);

/** 跳过原因 → 中文说明（导入报告中作为图例，页面也使用同一套文案） */
const SKIP_REASON_LABELS = {
  'key-not-found': '本轮比对中不存在该唯一键的冲突行',
  'not-conflict': '该键在本轮不是冲突行（已自动合并 / 新增 / 删除）',
  'already-decided': '本轮该行已存在裁决，整行保留人工操作',
  'presence-mismatch': '基准 / 本地 / 远端的行存在状态与方案不一致',
  'values-mismatch': '三方各列原值与方案不一致',
  'conflict-mismatch': '冲突类型（行级冲突或冲突列）与方案不一致',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isBool(v) {
  return v === true || v === false;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 计算一个冲突行的冲突签名：至多一个行级冲突，外加若干冲突列（列下标，升序）。
 * row-add-divergent 的分歧列同样落在 cells 中。
 */
function describeRowConflicts(row) {
  const rc = row.conflicts.find(
    (cf) => cf.type === 'row-delete-modify' || cf.type === 'row-add-divergent',
  );
  let cells;
  if (rc && rc.type === 'row-add-divergent') {
    cells = rc.differing.slice();
  } else {
    cells = row.conflicts.filter((cf) => cf.type === 'cell').map((cf) => cf.column);
  }
  return { row: rc ? rc.type : null, cells: cells.sort((a, b) => a - b) };
}

function sideValues(rec) {
  if (!rec) return null;
  return rec.cells.map((v) => (v == null ? '' : String(v)));
}

/**
 * 按已规范化的裁决，把一个已完整裁决的冲突行序列化成方案中的一行。
 */
function serializeConflictRow(row, decisions) {
  const desc = describeRowConflicts(row);
  const key = row.key;

  const decision = { row: null, cells: [] };
  if (desc.row) decision.row = ownProp(decisions.rowConflicts, key) || null;
  if (decision.row !== 'delete') {
    const cellDecisions = ownProp(decisions.cells, key) || keyedMap();
    for (const c of desc.cells) {
      const d = ownProp(cellDecisions, c);
      const item = { column: c, choice: d.choice };
      if (d.choice === 'manual') item.value = d.value;
      decision.cells.push(item);
    }
  }

  return {
    key,
    presence: { base: !!row.base, local: !!row.local, remote: !!row.remote },
    values: {
      base: sideValues(row.base),
      local: sideValues(row.local),
      remote: sideValues(row.remote),
    },
    conflicts: desc,
    decision,
  };
}

/**
 * 生成跨轮裁决方案：仅包含已完整裁决（无任何未决冲突）的冲突行。
 *
 * @returns {{ plan: object, unresolved: number, unresolvedDetails: string[] }}
 *   只要还有冲突行未完整裁决，unresolved > 0，调用方应拒绝导出方案。
 */
function buildPlan(model, decisions) {
  const rows = [];
  const unresolvedDetails = [];

  for (const row of model.rows) {
    if (row.status !== 'conflict') continue;
    const res = resolveRowProvenance(row, decisions, model.headers);
    if (res.unresolved.length > 0) {
      for (const msg of res.unresolved) {
        unresolvedDetails.push(`键 "${row.key}"：${msg}`);
      }
      continue;
    }
    rows.push(serializeConflictRow(row, decisions));
  }

  const plan = {
    kind: PLAN_KIND,
    version: PLAN_VERSION,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    headers: model.headers.slice(),
    rows,
  };
  return { plan, unresolved: unresolvedDetails.length, unresolvedDetails };
}

/**
 * 严格校验方案 JSON 的结构（不依赖任何本轮模型）。
 *
 * @returns {string|null} 错误信息；合法时返回 null。任何结构问题都必须在
 *   改动裁决之前被拒绝，保证"格式错误不得改动任何裁决"。
 */
function validatePlanStructure(plan) {
  if (!isPlainObject(plan)) return '方案必须是 JSON 对象';

  const allowedTop = new Set(['kind', 'version', 'generatedAt', 'keyColumn', 'headers', 'rows']);
  for (const k of Object.keys(plan)) {
    if (!allowedTop.has(k)) return `方案含未知字段 "${k}"`;
  }
  if (plan.kind !== PLAN_KIND) return `方案 kind 必须为 "${PLAN_KIND}"`;
  if (plan.version !== PLAN_VERSION) return `方案 version 必须为 ${PLAN_VERSION}`;
  if (!isNonEmptyString(plan.keyColumn)) return '方案的 keyColumn 必须是非空字符串';
  if (!Array.isArray(plan.headers) || plan.headers.length === 0) {
    return '方案的 headers 必须是非空数组';
  }
  if (!plan.headers.every((h) => typeof h === 'string')) {
    return '方案的 headers 必须全部是字符串';
  }
  if (new Set(plan.headers).size !== plan.headers.length) {
    return '方案的表头存在重复列名';
  }
  const keyIndex = plan.headers.indexOf(plan.keyColumn);
  if (keyIndex < 0) return '方案的 keyColumn 不在表头中';
  if (!Array.isArray(plan.rows)) return '方案的 rows 必须是数组';

  const seenKeys = new Set();
  for (let i = 0; i < plan.rows.length; i++) {
    const where = `方案第 ${i + 1} 行记录（rows[${i}]）`;
    const r = plan.rows[i];
    if (!isPlainObject(r)) return `${where} 必须是对象`;

    const allowedRow = new Set(['key', 'presence', 'values', 'conflicts', 'decision']);
    for (const k of Object.keys(r)) {
      if (!allowedRow.has(k)) return `${where} 含未知字段 "${k}"`;
    }

    if (!isNonEmptyString(r.key)) return `${where} 的 key 必须是非空字符串`;
    if (seenKeys.has(r.key)) return `${where} 的键 "${r.key}" 在方案中重复出现`;
    seenKeys.add(r.key);

    // presence：恰好 base/local/remote 三个布尔字段
    if (!isPlainObject(r.presence)) return `${where} 的 presence 必须是对象`;
    if (Object.keys(r.presence).length !== SIDES.length) {
      return `${where} 的 presence 必须且只能包含 base / local / remote`;
    }
    for (const side of SIDES) {
      if (!isBool(r.presence[side])) return `${where} 的 presence.${side} 必须是布尔值`;
    }

    // values：存在方给出与表头等长的字符串数组，不存在方必须为 null
    if (!isPlainObject(r.values)) return `${where} 的 values 必须是对象`;
    if (Object.keys(r.values).length !== SIDES.length) {
      return `${where} 的 values 必须且只能包含 base / local / remote`;
    }
    let somePresent = false;
    for (const side of SIDES) {
      const present = r.presence[side];
      const v = r.values[side];
      if (present) {
        somePresent = true;
        if (!Array.isArray(v)) return `${where} 标记 ${side} 存在，其 values.${side} 必须是数组`;
        if (v.length !== plan.headers.length) {
          return `${where} 的 values.${side} 列数（${v.length}）与表头列数（${plan.headers.length}）不一致`;
        }
        if (!v.every((x) => typeof x === 'string')) {
          return `${where} 的 values.${side} 各列原值必须全部是字符串`;
        }
        if (v[keyIndex] !== r.key) {
          return `${where} 的键列原值必须与 key 一致（均为 "${r.key}"）`;
        }
      } else if (v !== null) {
        return `${where} 标记 ${side} 不存在时，values.${side} 必须为 null`;
      }
    }
    if (!somePresent) return `${where} 基准 / 本地 / 远端不能同时都不存在`;

    // conflicts
    if (!isPlainObject(r.conflicts)) return `${where} 的 conflicts 必须是对象`;
    const cfKeys = Object.keys(r.conflicts);
    if (cfKeys.length !== 2 || !('row' in r.conflicts) || !('cells' in r.conflicts)) {
      return `${where} 的 conflicts 必须且只能包含 row 与 cells`;
    }
    const { row: rowConflict, cells: conflictCells } = r.conflicts;
    if (rowConflict !== null && !ROW_CONFLICT_TYPES.has(rowConflict)) {
      return `${where} 的 conflicts.row 不是合法的行级冲突类型`;
    }
    if (!Array.isArray(conflictCells) || !conflictCells.every((c) => Number.isInteger(c))) {
      return `${where} 的 conflicts.cells 必须是列下标整数数组`;
    }
    for (const c of conflictCells) {
      if (c < 0 || c >= plan.headers.length) {
        return `${where} 的冲突列下标 ${c} 超出表头范围`;
      }
      if (c === keyIndex) return `${where} 的唯一键列不可能是冲突列`;
    }
    if (new Set(conflictCells).size !== conflictCells.length) {
      return `${where} 的冲突列下标重复`;
    }
    if (rowConflict === null && conflictCells.length === 0) {
      return `${where} 至少要记录一个冲突（行级冲突或冲突列）`;
    }
    if (rowConflict === 'row-delete-modify' && conflictCells.length !== 0) {
      return `${where} 的"删除 / 修改"行级冲突不应再带冲突列`;
    }
    if (rowConflict === 'row-add-divergent' && conflictCells.length === 0) {
      return `${where} 的"同键异值新增"行级冲突必须记录至少一个分歧列`;
    }

    // decision
    if (!isPlainObject(r.decision)) return `${where} 的 decision 必须是对象`;
    const dKeys = Object.keys(r.decision);
    if (dKeys.length !== 2 || !('row' in r.decision) || !('cells' in r.decision)) {
      return `${where} 的 decision 必须且只能包含 row 与 cells`;
    }
    const { row: rowDecision, cells: cellDecisions } = r.decision;
    if (rowConflict === null) {
      if (rowDecision !== null) {
        return `${where} 没有行级冲突时 decision.row 必须为 null`;
      }
    } else if (!ROW_DECISIONS.has(rowDecision)) {
      return `${where} 有行级冲突时 decision.row 必须是 "keep" 或 "delete"`;
    }
    if (!Array.isArray(cellDecisions)) return `${where} 的 decision.cells 必须是数组`;

    // 各列裁决：删除整行时不允许再有逐格裁决；其余情况必须恰好覆盖全部冲突列
    const expectedCells =
      rowConflict === null || rowDecision === 'keep' ? conflictCells.slice() : [];
    expectedCells.sort((a, b) => a - b);
    const gotCells = cellDecisions
      .map((d) => {
        if (!isPlainObject(d)) return null;
        return Number.isInteger(d.column) ? d.column : null;
      })
      .filter((c) => c !== null)
      .sort((a, b) => a - b);
    if (gotCells.length !== cellDecisions.length) {
      return `${where} 的逐格裁决必须以整数 column 指定列下标`;
    }
    if (JSON.stringify(gotCells) !== JSON.stringify(expectedCells)) {
      return `${where} 的逐格裁决没有恰好覆盖其冲突列`;
    }

    const seenCellCols = new Set();
    for (const d of cellDecisions) {
      const allowed = new Set(['column', 'choice']);
      if (d.choice === 'manual') allowed.add('value');
      for (const k of Object.keys(d)) {
        if (!allowed.has(k)) return `${where} 的逐格裁决含未知字段 "${k}"`;
      }
      if (seenCellCols.has(d.column)) return `${where} 对同一冲突列给出了多条裁决`;
      seenCellCols.add(d.column);
      if (d.choice === 'local' || d.choice === 'remote') {
        if ('value' in d) return `${where} 取本地 / 取远端的裁决不应带 value`;
      } else if (d.choice === 'manual') {
        if (typeof d.value !== 'string') return `${where} 手填裁决必须带字符串 value（含空字符串）`;
      } else {
        return `${where} 的逐格裁决 choice 必须是 local / remote / manual`;
      }
    }
  }

  return null;
}

/**
 * 当前行是否已存在任一裁决（行级去留或任意逐格裁决）。
 * 只看自有属性：键为 "__proto__" 等继承属性名时也必须与普通键完全一致，
 * 不能因原型链上的内容误判为"已裁决"。
 */
function hasAnyDecision(decisions, key) {
  if (Object.prototype.hasOwnProperty.call(decisions.rowConflicts || keyedMap(), key)) return true;
  const cells = ownProp(decisions.cells, key);
  return !!cells && Object.keys(cells).length > 0;
}

function conflictsEqual(a, b) {
  return a.row === b.row && JSON.stringify(a.cells) === JSON.stringify(b.cells);
}

/**
 * 深拷贝一份按唯一键组织的裁决，保证返回值全部是无原型对象——
 * "__proto__" 等键只是普通自有属性，绝不落到任何对象的原型链上。
 * 不使用展开 / Object.assign 拷贝（会经 [[Set]] 触发 __proto__ 存取器）。
 */
function cloneDecisions(decisions) {
  const copy = { rowConflicts: keyedMap(), cells: keyedMap() };
  const rowConflicts = decisions && decisions.rowConflicts;
  if (rowConflicts && typeof rowConflicts === 'object') {
    for (const key of Object.keys(rowConflicts)) {
      if (rowConflicts[key] === 'keep' || rowConflicts[key] === 'delete') {
        copy.rowConflicts[key] = rowConflicts[key];
      }
    }
  }
  const cells = decisions && decisions.cells;
  if (cells && typeof cells === 'object') {
    for (const key of Object.keys(cells)) {
      const cols = cells[key];
      if (!cols || typeof cols !== 'object') continue;
      const colCopy = keyedMap();
      for (const col of Object.keys(cols)) {
        const dec = cols[col];
        if (!dec || typeof dec !== 'object') continue;
        if (dec.choice === 'local' || dec.choice === 'remote') {
          colCopy[col] = { choice: dec.choice };
        } else if (dec.choice === 'manual' && dec.value != null) {
          colCopy[col] = { choice: 'manual', value: String(dec.value) };
        }
      }
      copy.cells[key] = colCopy;
    }
  }
  return copy;
}

/**
 * 按本轮模型逐行核对并套用方案。纯函数：不修改传入的 decisions，
 * 返回一份合并后的新裁决对象（无原型，键可以是 "__proto__" 等任意合法字符串）
 * 与套用 / 跳过报告。
 *
 * 调用方需先用 validatePlanStructure 校验结构，并确认方案的 keyColumn / headers
 * 与本轮模型完全一致。
 *
 * @returns {{ decisions: object, report: object }}
 */
function applyPlan(model, decisions, plan) {
  const merged = cloneDecisions(decisions);

  const applied = [];
  const skipped = [];
  const byKey = new Map(model.rows.map((r) => [r.key, r]));
  const skip = (key, reason) =>
    skipped.push({ key, reason, reasonText: SKIP_REASON_LABELS[reason] });

  for (const prow of plan.rows) {
    const key = prow.key;
    const mrow = byKey.get(key);
    if (!mrow) {
      skip(key, 'key-not-found');
      continue;
    }
    if (mrow.status !== 'conflict') {
      skip(key, 'not-conflict');
      continue;
    }
    // 已有任一裁决：整行跳过，保留人工操作（优先于内容核对）
    if (hasAnyDecision(decisions, key)) {
      skip(key, 'already-decided');
      continue;
    }

    // 三方存在状态与各列原值必须完全相同（不裁剪空白、不做归一化）
    let mismatch = null;
    for (const side of SIDES) {
      const present = !!mrow[side];
      if (present !== prow.presence[side]) {
        mismatch = 'presence-mismatch';
        break;
      }
      if (!present) continue;
      const modelValues = mrow[side].cells;
      for (let c = 0; c < model.headers.length; c++) {
        if ((modelValues[c] == null ? '' : String(modelValues[c])) !== prow.values[side][c]) {
          mismatch = 'values-mismatch';
          break;
        }
      }
      if (mismatch) break;
    }
    if (mismatch) {
      skip(key, mismatch);
      continue;
    }

    // 冲突类型必须完全相同
    const desc = describeRowConflicts(mrow);
    if (!conflictsEqual(desc, prow.conflicts)) {
      skip(key, 'conflict-mismatch');
      continue;
    }

    // 全部一致：整行套用裁决（容器均为无原型对象，__proto__ 等键安全）
    if (prow.decision.row) merged.rowConflicts[key] = prow.decision.row;
    const cellMap = ownProp(merged.cells, key) || (merged.cells[key] = keyedMap());
    for (const item of prow.decision.cells) {
      const d = { choice: item.choice };
      if (item.choice === 'manual') d.value = item.value;
      cellMap[item.column] = d;
    }

    applied.push({
      key,
      row: prow.decision.row,
      cells: prow.decision.cells.map((item) => {
        const out = { column: model.headers[item.column], choice: item.choice };
        if (item.choice === 'manual') out.value = item.value;
        return out;
      }),
    });
  }

  const report = {
    kind: PLAN_KIND,
    version: PLAN_VERSION,
    keyColumn: model.keyColumn,
    total: plan.rows.length,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    skipped,
    reasonLegend: SKIP_REASON_LABELS,
  };
  return { decisions: merged, report };
}

module.exports = {
  PLAN_KIND,
  PLAN_VERSION,
  SKIP_REASON_LABELS,
  buildPlan,
  validatePlanStructure,
  applyPlan,
  describeRowConflicts,
  cloneDecisions,
};
