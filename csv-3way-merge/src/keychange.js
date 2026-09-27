'use strict';

/**
 * 疑似唯一键变更核对（suspected key-change check）。
 *
 * 有些"删除 + 新增"其实可能是同一行改了唯一键。冲突全部裁决后，本模块从本轮
 * 基准与最终结果提取两组键：
 *   - 消失键（旧键）：基准文件有、最终结果没有的键（按基准行序，附基准物理行号）；
 *   - 新增键（新键）：最终结果有、基准没有的键（按最终 CSV 行序，附最终行号）。
 * 两组各限 KEY_CHECK_LIMIT 个，任一组超限时不给出配对结论（limitExceeded），
 * 由调用方明确提示。
 *
 * 用户选择至少一个非键比较列，并设置 0 至比较列数的整数差异上限：旧键的基准行
 * 与新键的最终行逐格按原字符串比较（不裁剪空白、不做归一化），以不同格数为代价，
 * 代价超过上限的行对不能配对。随后求允许交叉的一对一配对——先让配对数最多，
 * 再让总代价最小（字典序目标）。
 *
 * 对每个旧键，列出所有最优方案中可能对应的新键，以及是否可能未配对；只有所有
 * 最优方案都把它配向同一新键时才标为稳定候选——候选只是核对线索，不能认定为
 * 真实改名。核对只读，不改变任何数据与裁决。
 *
 * 任一组为空时自然得到空配对：配对数与总代价均为 0，全部旧键列入未配对旧键。
 *
 * 配对与"所有最优方案的可能性"用同一套前后缀 DP 计算（组大小 ≤ 12，状态为
 * 新键子集掩码）：pre[i][mask] / suf[i][mask] 分别是只考虑前 i 个 / 第 i 个及
 * 之后旧键、已用新键集合为 mask 时的最大价值；价值把（配对数, 总代价）字典序
 * 编码为 pairs * BASE - cost（BASE 大于任何可达总代价，保证先比配对数）。
 * 固定"旧键 i 配向新键 j"或"旧键 i 不配对"后重取最优，若仍等于全局最优，
 * 说明存在某个最优方案满足该约束。
 */

const { resolveRowProvenance } = require('./merge');

/** 消失键 / 新增键每组最多参与核对的个数（任一组超出时明确提示，不给出配对） */
const KEY_CHECK_LIMIT = 12;

/**
 * 校验核对参数：至少一个非键比较列（在表头中、不是唯一键列、不重复）；
 * 差异上限为 0 至比较列数的整数。
 * @returns {string|null} 错误信息；合法时返回 null
 */
function validateKeyCheckParams(model, columns, maxDiff) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return '请至少选择一个非键比较列';
  }
  const seen = new Set();
  for (const col of columns) {
    if (typeof col !== 'string' || !model.headers.includes(col)) {
      return `比较列 "${col}" 不在表头中`;
    }
    if (col === model.keyColumn) {
      return '比较列不能是唯一键列';
    }
    if (seen.has(col)) {
      return `比较列 "${col}" 重复`;
    }
    seen.add(col);
  }
  if (!Number.isInteger(maxDiff) || maxDiff < 0 || maxDiff > columns.length) {
    return `差异上限必须是 0 至比较列数（${columns.length}）的整数`;
  }
  return null;
}

/**
 * 生成疑似唯一键变更核对结果。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string[]} columns 非键比较列（调用前需先经 validateKeyCheckParams 校验）
 * @param {number} maxDiff 差异上限（0 至 columns.length 的整数）
 * @returns {{ unresolved: number, unresolvedDetails: string[],
 *             limitExceeded?: {oldCount:number, newCount:number, limit:number},
 *             check?: object }}
 *   有未决冲突时只返回 unresolved / unresolvedDetails（不给出结论）；
 *   任一组超过 KEY_CHECK_LIMIT 时返回 limitExceeded（不给出配对）；
 *   否则 check 为完整核对结果：
 *     pairCount / totalCost   最优配对数与最小总代价
 *     candidateCount / candidateCost  稳定候选数与候选代价（候选配对代价之和）
 *     pairs                  一组最优配对 [{ oldKey, newKey, cost }]（允许交叉）
 *     oldKeys[]              每个旧键 { key, line, possibleNewKeys:[{newKey,cost}],
 *                              canBeUnpaired, stable, stableNewKey, stableCost }
 *     newKeys[]              每个新键 { key, line, pairable }
 *     unpairedOldKeys / unpairedNewKeys  所有最优方案中都不配对的旧键 / 新键
 */
function buildKeyChangeCheck(model, decisions, columns, maxDiff) {
  // 最终保留行：与 CSV 导出、来源账本、层级核验同一套 resolveRowProvenance
  const finalRows = [];
  const unresolvedDetails = [];
  const baseByKey = new Map(); // 键 → 基准行 { line, cells }
  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, model.headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
    if (!res.deleted) finalRows.push({ key: res.key, cells: res.cells });
    if (row.base && !baseByKey.has(row.key)) {
      baseByKey.set(row.key, { line: row.base.line, cells: row.base.cells });
    }
  }
  if (unresolvedDetails.length > 0) {
    return { unresolved: unresolvedDetails.length, unresolvedDetails };
  }

  // 消失键：基准有、最终结果没有（按基准行序）；新增键：最终结果有、基准没有（按最终 CSV 行序）
  const finalKeySet = new Set(finalRows.map((r) => r.key));
  const oldKeys = [];
  for (const row of model.rows) {
    if (row.base && !finalKeySet.has(row.key)) {
      oldKeys.push({ key: row.key, line: row.base.line, cells: row.base.cells });
    }
  }
  const newKeys = [];
  finalRows.forEach((r, i) => {
    if (!baseByKey.has(r.key)) newKeys.push({ key: r.key, line: i + 2, cells: r.cells });
  });

  // 任一组超限：明确提示，不给出配对结论
  if (oldKeys.length > KEY_CHECK_LIMIT || newKeys.length > KEY_CHECK_LIMIT) {
    return {
      unresolved: 0,
      unresolvedDetails: [],
      limitExceeded: {
        oldCount: oldKeys.length,
        newCount: newKeys.length,
        limit: KEY_CHECK_LIMIT,
      },
    };
  }

  const n = oldKeys.length;
  const m = newKeys.length;
  const colIdx = columns.map((c) => model.headers.indexOf(c));
  const cellAt = (cells, i) => {
    const v = cells[i];
    return v == null ? '' : v;
  };

  // 代价矩阵：逐格按原字符串比较，不同格数即为代价；超过上限的行对不能配对
  const cost = [];
  const allowed = [];
  for (let i = 0; i < n; i++) {
    cost.push([]);
    allowed.push([]);
    for (let j = 0; j < m; j++) {
      let c = 0;
      for (const ci of colIdx) {
        if (cellAt(oldKeys[i].cells, ci) !== cellAt(newKeys[j].cells, ci)) c++;
      }
      cost[i].push(c);
      allowed[i].push(c <= maxDiff);
    }
  }

  // 价值编码：pairs * BASE - cost，BASE 大于任何可达总代价（至多 min(n,m) 对、
  // 每对至多 maxDiff），保证先让配对数最多、再让总代价最小
  const costCap = Math.min(n, m) * maxDiff;
  const BASE = costCap + 1;
  const NEG = -Infinity;
  const S = 1 << m;

  // pre[i][mask]：只考虑前 i 个旧键、已用新键集合为 mask 时的最大价值
  const pre = [new Array(S).fill(NEG)];
  pre[0][0] = 0;
  for (let i = 0; i < n; i++) {
    const cur = pre[i];
    const nxt = cur.slice(); // 旧键 i 不配对
    for (let mask = 0; mask < S; mask++) {
      const v = cur[mask];
      if (v === NEG) continue;
      for (let j = 0; j < m; j++) {
        const bit = 1 << j;
        if ((mask & bit) !== 0 || !allowed[i][j]) continue;
        const nm = mask | bit;
        const val = v + BASE - cost[i][j];
        if (val > nxt[nm]) nxt[nm] = val;
      }
    }
    pre.push(nxt);
  }

  // suf[i][mask]：只考虑第 i 个及之后的旧键、已用新键集合为 mask 时的最大价值
  const suf = new Array(n + 1);
  suf[n] = new Array(S).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const rest = suf[i + 1];
    const cur = rest.slice(); // 旧键 i 不配对
    for (let mask = 0; mask < S; mask++) {
      for (let j = 0; j < m; j++) {
        const bit = 1 << j;
        if ((mask & bit) !== 0 || !allowed[i][j]) continue;
        const v = rest[mask | bit]; // 旧键 i 配向新键 j 后，剩余旧键面对更大的已用集合
        if (v === NEG) continue;
        const val = v + BASE - cost[i][j];
        if (val > cur[mask]) cur[mask] = val;
      }
    }
    suf[i] = cur;
  }

  const optimal = suf[0][0];
  const pairCount = Math.ceil(optimal / BASE);
  const totalCost = pairCount * BASE - optimal;

  // 逐旧键：枚举"配向新键 j"或"不配对"，用前后缀 DP 判断该约束下能否仍达全局最优；
  // 能则说明存在某个最优方案满足该约束（即"所有最优方案中可能对应 / 可能未配对"）
  const newKeyPairable = new Array(m).fill(false);
  const oldResults = [];
  for (let i = 0; i < n; i++) {
    const preI = pre[i];
    const sufI = suf[i + 1];
    const possible = [];
    for (let j = 0; j < m; j++) {
      if (!allowed[i][j]) continue;
      const bit = 1 << j;
      let best = NEG;
      for (let mask = 0; mask < S; mask++) {
        if ((mask & bit) !== 0) continue;
        const a = preI[mask];
        if (a === NEG) continue;
        const b = sufI[mask | bit];
        if (b === NEG) continue;
        const val = a + BASE - cost[i][j] + b;
        if (val > best) best = val;
      }
      if (best === optimal) {
        possible.push({ newKey: newKeys[j].key, cost: cost[i][j] });
        newKeyPairable[j] = true;
      }
    }
    let bestSkip = NEG;
    for (let mask = 0; mask < S; mask++) {
      const a = preI[mask];
      if (a === NEG) continue;
      const b = sufI[mask];
      if (b === NEG) continue;
      if (a + b > bestSkip) bestSkip = a + b;
    }
    const canBeUnpaired = bestSkip === optimal;
    // 只有所有最优方案都配向同一新键（唯一可能且不可能未配对）才是稳定候选
    const stable = possible.length === 1 && !canBeUnpaired;
    oldResults.push({
      key: oldKeys[i].key,
      line: oldKeys[i].line,
      possibleNewKeys: possible,
      canBeUnpaired,
      stable,
      stableNewKey: stable ? possible[0].newKey : null,
      stableCost: stable ? possible[0].cost : null,
    });
  }

  // 构造一组最优配对（允许交叉）：沿 suf 走一条始终能达到全局最优的路径
  const pairs = [];
  let mask = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let chosen = -1;
    for (let j = 0; j < m; j++) {
      const bit = 1 << j;
      if ((mask & bit) !== 0 || !allowed[i][j]) continue;
      if (acc + BASE - cost[i][j] + suf[i + 1][mask | bit] === optimal) {
        chosen = j;
        break;
      }
    }
    if (chosen >= 0) {
      pairs.push({ oldKey: oldKeys[i].key, newKey: newKeys[chosen].key, cost: cost[i][chosen] });
      acc += BASE - cost[i][chosen];
      mask |= 1 << chosen;
    }
  }

  const candidateCount = oldResults.filter((r) => r.stable).length;
  const candidateCost = oldResults.reduce((s, r) => s + (r.stable ? r.stableCost : 0), 0);

  const check = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    columns: columns.slice(),
    maxDiff,
    limit: KEY_CHECK_LIMIT,
    oldCount: n,
    newCount: m,
    pairCount,
    totalCost,
    candidateCount,
    candidateCost,
    pairs,
    oldKeys: oldResults,
    newKeys: newKeys.map((k, j) => ({ key: k.key, line: k.line, pairable: newKeyPairable[j] })),
    unpairedOldKeys: oldResults.filter((r) => r.possibleNewKeys.length === 0).map((r) => r.key),
    unpairedNewKeys: newKeys.filter((_, j) => !newKeyPairable[j]).map((k) => k.key),
    disclaimer:
      '稳定候选仅表示所有最优配对方案的一致指向，是核对线索，不能认定为真实改名；核对不改变任何数据与裁决。',
  };
  return { unresolved: 0, unresolvedDetails: [], check };
}

module.exports = { KEY_CHECK_LIMIT, validateKeyCheckParams, buildKeyChangeCheck };
