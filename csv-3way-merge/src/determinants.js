'use strict';

/**
 * 最小决定列发现（minimal determining columns）。
 *
 * 冲突全部裁决后，本模块按本轮保存的模型与当前裁决算出最终保留行（与 CSV 导出、
 * 来源账本、层级核验共用 merge.js 中的 resolveRowProvenance，行序与逐格取值完全
 * 一致），回答一个问题：**哪些候选列组合能函数决定目标列？**
 *
 * 判定规则（函数依赖）：任意两行在组合各列上的取值（按原字符串精确比较，不裁剪
 * 空白，空字符串 "" 也是一个普通值）全部相同时，目标列取值也必须相同，该组合
 * 才成立。
 *
 * 枚举**所有**成立且任何真子集都不成立的组合（最小决定组合），不能只找列数最少
 * 者——不同列数的最小组合可以同时存在：
 *  - 目标列在全部保留行中恒定时，空组合（不需要任何列）即成立，且只返回空组合；
 *  - 对每个非空最小组合，逐列移除后得到的真子集必然不成立，附一对"在剩余列上
 *       相同、目标值却不同"的行作为失效证明，行对按最终行序取字典序最早者；
 *  - 连全部候选列都不能决定目标列时不存在任何成立组合，给出一对"全候选列相同
 *       而目标不同"的反例行（同样取字典序最早行对）。
 *
 * 最终保留行最多 ROW_LIMIT 行，超限不给出结论（limitExceeded），由调用方提示。
 * 分析只读，不改变任何数据与裁决；有未决冲突时不产出结论。
 *
 * 候选列至多 10 个，因此可直接枚举全部 2^k（≤1024）个子集：逐子集按行序做一次
 * 分桶，扫描中记录桶内目标冲突的全部行对、保留其中字典序最早者（先让第一行
 * 行号最小，同第一行时第二行行号最小）。
 */

const { resolveRowProvenance } = require('./merge');

/** 参与发现的最终保留行上限（超出时明确提示，不给出结论） */
const DETERMINANT_ROW_LIMIT = 300;

/** 候选列数量上下限 */
const CANDIDATE_MIN = 1;
const CANDIDATE_MAX = 10;

/**
 * 校验发现参数：
 *  - 目标列必须给出、存在于表头、且不能是唯一键列；
 *  - 候选列必须为 1～10 个互异列名，各自存在于表头，且不含唯一键列与目标列。
 * @returns {string|null} 错误信息；合法时返回 null
 */
function validateDeterminantParams(model, targetColumn, candidates) {
  if (!targetColumn || typeof targetColumn !== 'string') {
    return '请求缺少 targetColumn（目标列）';
  }
  if (!model.headers.includes(targetColumn)) {
    return `目标列 "${targetColumn}" 不在表头中`;
  }
  if (targetColumn === model.keyColumn) {
    return '目标列不能是唯一键列';
  }
  if (!Array.isArray(candidates)) {
    return `请选择 ${CANDIDATE_MIN} 至 ${CANDIDATE_MAX} 个互异候选列`;
  }
  if (candidates.length < CANDIDATE_MIN || candidates.length > CANDIDATE_MAX) {
    return `候选列数量必须为 ${CANDIDATE_MIN} 至 ${CANDIDATE_MAX} 个（当前 ${candidates.length} 个）`;
  }
  const seen = new Set();
  for (const col of candidates) {
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
 * 生成最小决定列发现结果。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} targetColumn 目标列名（调用前需先经 validateDeterminantParams 校验）
 * @param {string[]} candidates 候选列名（调用前需先经 validateDeterminantParams 校验）
 * @returns {{ unresolved: number, unresolvedDetails: string[],
 *             limitExceeded?: {rowCount:number, limit:number},
 *             result?: object }}
 *   有未决冲突时只返回 unresolved / unresolvedDetails（不给出结论）；
 *   最终保留行超过 DETERMINANT_ROW_LIMIT 时返回 limitExceeded（不给出结论）；
 *   否则 result 为完整发现结果（无保留行时 result.noData=true）。
 */
function buildDeterminants(model, decisions, targetColumn, candidates) {
  const headers = model.headers;

  // 最终保留行：与 CSV 导出、来源账本、层级核验、键变更核对同一套 resolveRowProvenance
  const finalRows = [];
  const unresolvedDetails = [];
  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
    if (!res.deleted) finalRows.push({ key: res.key, cells: res.cells });
  }
  if (unresolvedDetails.length > 0) {
    return { unresolved: unresolvedDetails.length, unresolvedDetails };
  }

  // 超限明确提示，不给出结论
  if (finalRows.length > DETERMINANT_ROW_LIMIT) {
    return {
      unresolved: 0,
      unresolvedDetails: [],
      limitExceeded: { rowCount: finalRows.length, limit: DETERMINANT_ROW_LIMIT },
    };
  }

  // 候选列统一按基准表头列序处理，保证组合枚举 / 排序稳定
  const candColumns = candidates.slice().sort(
    (a, b) => headers.indexOf(a) - headers.indexOf(b),
  );
  const candIdx = candColumns.map((c) => headers.indexOf(c));
  const targetIdx = headers.indexOf(targetColumn);
  const n = finalRows.length;
  const cellAt = (row, i) => {
    const v = row.cells[i];
    return v == null ? '' : v;
  };
  const targetValues = finalRows.map((r) => cellAt(r, targetIdx));

  const base = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    targetColumn,
    candidateColumns: candColumns,
    limit: DETERMINANT_ROW_LIMIT,
    rowCount: n,
  };

  // 无保留行：明确提示无数据
  if (n === 0) {
    return {
      unresolved: 0,
      unresolvedDetails: [],
      result: {
        ...base,
        noData: true,
        constantTarget: false,
        combinationCount: 0,
        combinations: [],
        counterexample: null,
        disclaimer: makeDisclaimer(),
      },
    };
  }

  const k = candColumns.length;

  // 每列不同字符串按出现顺序 intern 成整数编码：子集分桶键由整数编码拼接，
  // 配合分隔符可无碰撞地表示取值序列，且空字符串也只是编码 0 的普通值。
  const colCodes = [];
  for (let p = 0; p < k; p++) {
    const intern = new Map();
    colCodes.push(
      finalRows.map((r) => {
        const v = cellAt(r, candIdx[p]);
        let code = intern.get(v);
        if (code === undefined) {
          code = intern.size;
          intern.set(v, code);
        }
        return code;
      }),
    );
  }
  const targetIntern = new Map();
  const targetCodes = targetValues.map((v) => {
    let code = targetIntern.get(v);
    if (code === undefined) {
      code = targetIntern.size;
      targetIntern.set(v, code);
    }
    return code;
  });

  /**
   * 分析一个子集（位 p 对应该位上的候选列）：
   * 按子集各列取值分桶，桶内出现不同目标值即不成立。扫描全部行，记录其中
   * 字典序最早的失效行对 [i, j]（i<j，先让 i 最小，同 i 时 j 最小）：对每个
   * 冲突行 j，桶内最早一个异目标先行行 i 即该 j 的最优 i，全局比较取 i 最小者；
   * 空子集时所有行同桶，成立当且仅当目标恒定。
   */
  function analyze(mask) {
    const positions = [];
    for (let p = 0; p < k; p++) if (mask & (1 << p)) positions.push(p);
    // 桶键 → byTarget：各目标值在桶内首次出现的行号（Map 按插入序）；
    // 整数编码用 '\x01'（整数不含该字符）拼接，无碰撞；空串值只是编码 0 的普通值
    const groups = new Map();
    let bestI = n;
    let bestJ = -1;
    for (let j = 0; j < n; j++) {
      const key = positions.map((p) => colCodes[p][j]).join('\x01');
      let byTarget = groups.get(key);
      if (!byTarget) {
        byTarget = new Map();
        byTarget.set(targetCodes[j], j);
        groups.set(key, byTarget);
        continue;
      }
      // 新出现的目标值也要登记：后续行可能与它构成行号更晚的冲突
      if (!byTarget.has(targetCodes[j])) byTarget.set(targetCodes[j], j);
      // Map 首个异值条目即桶内行号最小的异目标先行行
      let i = -1;
      for (const [tc, idx] of byTarget) {
        if (tc !== targetCodes[j]) {
          i = idx;
          break;
        }
      }
      if (i >= 0 && i < bestI) {
        bestI = i;
        bestJ = j;
      }
    }
    return bestJ >= 0 ? { valid: false, pair: [bestI, bestJ] } : { valid: true, pair: null };
  }

  const size = 1 << k;
  const info = new Array(size);
  for (let mask = 0; mask < size; mask++) info[mask] = analyze(mask);

  const full = size - 1;

  const pairRow = (i) => ({
    key: finalRows[i].key,
    line: i + 2, // 最终 CSV 物理行号（表头为第 1 行）
    targetValue: targetValues[i],
  });

  // 全部候选列都不成立 → 不存在任何成立组合，给出全候选列相同而目标不同的反例
  if (!info[full].valid) {
    const [i, j] = info[full].pair;
    const result = {
      ...base,
      noData: false,
      constantTarget: false,
      combinationCount: 0,
      combinations: [],
      counterexample: {
        row1: pairRow(i),
        row2: pairRow(j),
        // 两行在全部候选列上取值相同（由分桶构造保证），附上共享值便于复核
        values: candColumns.map((col, p) => ({
          column: col,
          value: cellAt(finalRows[i], candIdx[p]),
        })),
      },
      disclaimer: makeDisclaimer(),
    };
    return { unresolved: 0, unresolvedDetails: [], result };
  }

  // 最小组合：自身成立，且删去任意一列后都不成立（真子集成⽴ ⇒ 某个删一列的
  // 超集也成立，故只需检查删一列子集；空组合成立时它是唯一的最小组合）。
  const minimal = [];
  for (let mask = 0; mask < size; mask++) {
    if (!info[mask].valid) continue;
    let isMinimal = true;
    for (let p = 0; p < k; p++) {
      if ((mask & (1 << p)) !== 0 && info[mask ^ (1 << p)].valid) {
        isMinimal = false;
        break;
      }
    }
    if (isMinimal) minimal.push(mask);
  }

  // 排列：先按列数，再按基准表头列序（候选已按表头列序排列）字典序
  minimal.sort((m1, m2) => {
    const a = maskPositions(m1, k);
    const b = maskPositions(m2, k);
    if (a.length !== b.length) return a.length - b.length;
    for (let t = 0; t < a.length; t++) {
      if (a[t] !== b[t]) return a[t] - b[t];
    }
    return 0;
  });

  const combinations = minimal.map((mask) => {
    const positions = maskPositions(mask, k);
    const columns = positions.map((p) => candColumns[p]);
    // 每个非空组合逐列移除：附该剩余子集字典序最早的失效行对（最小性保证其存在）
    const witnesses = positions.map((p) => {
      const [i, j] = info[mask ^ (1 << p)].pair;
      return { removedColumn: candColumns[p], row1: pairRow(i), row2: pairRow(j) };
    });
    return { columnCount: columns.length, columns, witnesses };
  });

  const result = {
    ...base,
    noData: false,
    constantTarget: info[0].valid,
    combinationCount: combinations.length,
    combinations,
    counterexample: null,
    disclaimer: makeDisclaimer(),
  };
  return { unresolved: 0, unresolvedDetails: [], result };
}

function maskPositions(mask, k) {
  const positions = [];
  for (let p = 0; p < k; p++) if (mask & (1 << p)) positions.push(p);
  return positions;
}

function makeDisclaimer() {
  return (
    '本结论仅基于本轮合并后的当前数据（最终保留行，按原字符串比较，空串也是值）得出，' +
    '只在当前数据范围内成立；裁决或选列变化、数据增减后可能不再成立，需重新计算。'
  );
}

module.exports = {
  DETERMINANT_ROW_LIMIT,
  CANDIDATE_MIN,
  CANDIDATE_MAX,
  validateDeterminantParams,
  buildDeterminants,
};
