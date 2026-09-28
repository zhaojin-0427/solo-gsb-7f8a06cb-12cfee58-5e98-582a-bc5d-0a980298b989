'use strict';

/**
 * 最小决定列发现（minimal determinant columns）。
 *
 * 冲突全部裁决后，按本轮保存的模型与当前裁决算出最终保留行（与 CSV 导出、
 * 来源账本、层级核验共用 merge.js 中的 resolveRowProvenance，行序与逐格取值
 * 完全一致），回答一个问题：**哪些候选列的组合能函数决定目标列？**
 *
 * 用户选择一个非键目标列与 1～10 个互异候选列（候选不得含目标列或唯一键列）。
 * 判定规则：逐格按原字符串比较（不裁剪空白、不做归一化，空字符串也是一个值），
 * 若任意两行在组合各列上的取值都相同，它们的目标值也必相同，则该组合成立
 * （holds，函数依赖 X → target）。
 *
 * 最终保留行最多参与计算 DETERMINANT_ROW_LIMIT 行，超限时不给出结论
 * （limitExceeded），由调用方明确提示；一行都没有时由调用方提示无数据。
 *
 * 枚举**所有**成立且任何真子集均不成立的组合（最小函数依赖的左部），不能只找
 * 列数最少者：列数更少与更多的最小组合会同时返回。组合先按列数、再按基准表头
 * 列序排列。目标列在所有行上恒定时，只有空组合成立，仅返回空组合。
 *
 * 每个非空组合逐列移除：移除任一列后的真子集必不成立（最小性定义），附上一对
 * "在剩余列上完全相同、目标值却不同"的行作为该列必要的证明；证明行对按最终
 * CSV 行序取字典序最早的一对（先比第一行下标、再比第二行下标）。
 *
 * 一个成立的组合都没有时，全候选列集合必然不成立（否则其最小子集至少有一个），
 * 给出全候选列相同而目标不同的反例行对（同样取字典序最早的一对）。
 *
 * 发现只读，不改变任何数据与裁决，结论仅适用于当前数据。
 */

const { resolveRowProvenance } = require('./merge');

/** 参与发现的最终保留行上限（超限时明确提示，不给出结论） */
const DETERMINANT_ROW_LIMIT = 300;

/** 候选列个数上下限 */
const DETERMINANT_MIN_CANDIDATES = 1;
const DETERMINANT_MAX_CANDIDATES = 10;

/**
 * 校验发现参数：目标列必须给出、在表头中且不是唯一键列；候选列必须为
 * 1～10 个互异列，每列在表头中，且不能是唯一键列或目标列。
 * @returns {string|null} 错误信息；合法时返回 null
 */
function validateDeterminantParams(model, targetColumn, candidateColumns) {
  if (!targetColumn || typeof targetColumn !== 'string') {
    return '请求缺少 targetColumn（目标列）';
  }
  if (!model.headers.includes(targetColumn)) {
    return `目标列 "${targetColumn}" 不在表头中`;
  }
  if (targetColumn === model.keyColumn) {
    return '目标列不能是唯一键列';
  }
  if (!Array.isArray(candidateColumns)) {
    return '候选列必须是列名数组';
  }
  if (candidateColumns.length < DETERMINANT_MIN_CANDIDATES) {
    return '请至少选择一个候选列';
  }
  if (candidateColumns.length > DETERMINANT_MAX_CANDIDATES) {
    return `候选列最多 ${DETERMINANT_MAX_CANDIDATES} 个`;
  }
  const seen = new Set();
  for (const col of candidateColumns) {
    if (typeof col !== 'string' || !model.headers.includes(col)) {
      return `候选列 "${col}" 不在表头中`;
    }
    if (col === model.keyColumn) {
      return '候选列不能包含唯一键列';
    }
    if (col === targetColumn) {
      return '候选列不能包含目标列';
    }
    if (seen.has(col)) {
      return `候选列 "${col}" 重复`;
    }
    seen.add(col);
  }
  return null;
}

/**
 * 取单元格值：null / undefined 归一为空串；其余一律按原字符串保留。
 */
function cellValue(cells, idx) {
  const v = cells[idx];
  return v == null ? '' : v;
}

/**
 * 组合签名：参与比较各列原字符串拼接出的键（JSON 保留元素边界与空串）。
 * 空组合签名恒为 '[]'——所有行在空列集合上天然相同。
 */
function signature(cells, colIdx) {
  if (colIdx.length === 0) return '[]';
  const parts = new Array(colIdx.length);
  for (let i = 0; i < colIdx.length; i++) parts[i] = cellValue(cells, colIdx[i]);
  return JSON.stringify(parts);
}

/**
 * 找一对"在 colIdx 各列上取值相同、目标列取值不同"的行。
 * 单次遍历按组合签名分组：记录每组行序最早的行（及目标值），以及组内第一个
 * 目标值与之不同的行；所有组比较后返回字典序最早的一对
 * （first 下标最小，并列时 second 下标最小）。
 *
 * @param {Array<{key:string, cells:string[], line:number}>} rows 最终保留行（最终 CSV 行序）
 * @param {number[]} colIdx 组合各列在表头中的下标（升序）
 * @param {number} targetIdx 目标列下标
 * @returns {{first:object, second:object}|null} 行对（含键 / 最终行号 / 目标值）；组合成立时为 null
 */
function findWitnessPair(rows, colIdx, targetIdx) {
  // 签名 → { first: 组内行序最早行下标, firstTarget, diff: 首个不同目标行下标 }
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const sig = signature(rows[i].cells, colIdx);
    const target = cellValue(rows[i].cells, targetIdx);
    const g = groups.get(sig);
    if (!g) {
      groups.set(sig, { first: i, firstTarget: target, diff: -1 });
    } else if (g.diff === -1 && target !== g.firstTarget) {
      g.diff = i;
    }
  }

  let best = null;
  for (const g of groups.values()) {
    if (g.diff === -1) continue;
    if (!best || g.first < best.first || (g.first === best.first && g.diff < best.second)) {
      best = { first: g.first, second: g.diff };
    }
  }
  if (!best) return null;
  return {
    first: describeRow(rows[best.first], targetIdx),
    second: describeRow(rows[best.second], targetIdx),
  };
}

function describeRow(row, targetIdx) {
  return { key: row.key, line: row.line, targetValue: cellValue(row.cells, targetIdx) };
}

/**
 * 生成最小决定列发现结果。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} targetColumn 非键目标列（调用前需先经 validateDeterminantParams 校验）
 * @param {string[]} candidateColumns 1～10 个互异候选列（不含唯一键列 / 目标列）
 * @returns {{ unresolved: number, unresolvedDetails: string[],
 *             limitExceeded?: {rowCount:number, limit:number},
 *             emptyData?: boolean, analysis?: object }}
 *   有未决冲突时只返回 unresolved / unresolvedDetails（不给出结论）；
 *   最终保留行超过 DETERMINANT_ROW_LIMIT 时返回 limitExceeded（不给出结论）；
 *   一行都没有时返回 emptyData（提示无数据）；
 *   否则 analysis 为完整发现结果。
 */
function buildDeterminants(model, decisions, targetColumn, candidateColumns) {
  // 最终保留行：与 CSV 导出、来源账本、层级核验、键变更核对同一套 resolveRowProvenance
  const rows = [];
  const unresolvedDetails = [];
  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, model.headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
    if (!res.deleted) {
      // line 为最终 CSV 物理行号（表头为第 1 行，首行数据为第 2 行）
      rows.push({ key: res.key, cells: res.cells, line: rows.length + 2 });
    }
  }
  if (unresolvedDetails.length > 0) {
    return { unresolved: unresolvedDetails.length, unresolvedDetails };
  }

  // 超限明确提示，不给出结论
  if (rows.length > DETERMINANT_ROW_LIMIT) {
    return {
      unresolved: 0,
      unresolvedDetails: [],
      limitExceeded: { rowCount: rows.length, limit: DETERMINANT_ROW_LIMIT },
    };
  }

  // 一行都没有：目标列无值可比，提示无数据
  if (rows.length === 0) {
    return { unresolved: 0, unresolvedDetails: [], emptyData: true };
  }

  const targetIdx = model.headers.indexOf(targetColumn);
  // 候选列规范化为基准表头列序（参数已校验合法、互异）
  const candIdx = candidateColumns
    .map((c) => model.headers.indexOf(c))
    .sort((a, b) => a - b);
  const k = candIdx.length;

  // 空组合成立 ⇔ 目标列在所有行上恒定
  const emptyPair = findWitnessPair(rows, [], targetIdx);
  const emptyHolds = emptyPair === null;

  // 对候选列的每个非空子集（位掩码）判定是否成立，并缓存反例行对供最小性证明复用。
  // 候选至多 10 列 → 至多 1023 个子集、每子集 ≤ 300 行，可直接穷举。
  const holds = new Set();
  const witnessCache = new Map();
  for (let mask = 1; mask < 1 << k; mask++) {
    const colIdx = maskToColumns(mask, candIdx);
    const pair = findWitnessPair(rows, colIdx, targetIdx);
    if (pair === null) holds.add(mask);
    else witnessCache.set(mask, pair);
  }

  // 空组合（mask 0）的反例：单列最小组合移除唯一列时需要它做证明
  if (emptyPair) witnessCache.set(0, emptyPair);

  const combinations = [];

  if (emptyHolds) {
    // 目标恒定：仅返回空组合（空组合没有可逐列移除的列，也无需证明）
    combinations.push({ size: 0, columns: [], witnesses: [] });
  } else {
    // 最小成立组合：成立且没有任何成立的真子集（不同列数的最小组合全部保留）
    for (let mask = 1; mask < 1 << k; mask++) {
      if (!holds.has(mask) || !isMinimal(mask, holds)) continue;
      const colIdx = maskToColumns(mask, candIdx);
      // 逐列移除：移除后的真子集不成立，缓存中必有反例行对；按组合列序（表头列序）给出
      const witnesses = [];
      for (let b = 0; b < k; b++) {
        if (!(mask & (1 << b))) continue;
        const subMask = mask & ~(1 << b);
        witnesses.push({
          removedColumn: model.headers[candIdx[b]],
          pair: witnessCache.get(subMask),
        });
      }
      combinations.push({
        size: colIdx.length,
        columns: colIdx.map((ci) => model.headers[ci]),
        witnesses,
      });
    }
    // 先按列数、再按基准表头列序排列（candIdx 已按表头列序，按下标序列字典序比较）
    combinations.sort((a, b) => {
      if (a.size !== b.size) return a.size - b.size;
      const ai = a.columns.map((c) => model.headers.indexOf(c));
      const bi = b.columns.map((c) => model.headers.indexOf(c));
      for (let i = 0; i < ai.length; i++) {
        if (ai[i] !== bi[i]) return ai[i] - bi[i];
      }
      return 0;
    });
  }

  // 一个成立组合都没有时，全候选列集合必然不成立：给出全候选列相同而目标不同的反例
  let counterexample = null;
  if (!emptyHolds && combinations.length === 0) {
    const fullMask = (1 << k) - 1;
    counterexample = {
      columns: candIdx.map((ci) => model.headers[ci]),
      // 全候选列集合已在上面的子集枚举中判定过（不成立），直接复用其反例行对
      pair: witnessCache.get(fullMask),
    };
  }

  const analysis = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    targetColumn,
    candidateColumns: candIdx.map((ci) => model.headers[ci]),
    rowCount: rows.length,
    limit: DETERMINANT_ROW_LIMIT,
    constant: emptyHolds,
    combinationCount: combinations.length,
    combinations,
    counterexample,
    disclaimer:
      '结论仅基于本轮模型与当前裁决得到的最终保留行（按原字符串比较，空串也是值），' +
      '只适用于当前数据；发现过程不改变任何数据与裁决。',
  };
  return { unresolved: 0, unresolvedDetails: [], analysis };
}

/** 位掩码 → 对应的表头列下标（按 candIdx 顺序，即基准表头列序） */
function maskToColumns(mask, candIdx) {
  const out = [];
  for (let b = 0; b < candIdx.length; b++) {
    if (mask & (1 << b)) out.push(candIdx[b]);
  }
  return out;
}

/**
 * 是否为最小成立组合：成立且没有任何非空真子集成立。
 * （空组合恒成立的情况由调用方单独处理，不进入这里的非空组合枚举。）
 */
function isMinimal(mask, holds) {
  for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
    if (holds.has(sub)) return false;
  }
  return true;
}

module.exports = {
  DETERMINANT_ROW_LIMIT,
  DETERMINANT_MIN_CANDIDATES,
  DETERMINANT_MAX_CANDIDATES,
  validateDeterminantParams,
  buildDeterminants,
  findWitnessPair,
};
