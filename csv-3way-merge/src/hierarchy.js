'use strict';

/**
 * 合并结果父子层级核验。
 *
 * 冲突全部裁决后，按本轮保存的模型与当前裁决算出最终保留行（与 CSV 导出、
 * 来源账本共用 merge.js 中的 resolveRowProvenance，行序与逐格取值完全一致），
 * 以最终唯一键建立索引，核验父键列：
 *  - 空字符串父键视为根，不参与任何问题判定；
 *  - 其余父键按原字符串精确匹配（不裁剪空白）：
 *      指向不存在或已删除的键 → missing-parent（缺失父项）；
 *      指向自身（自环）或多行相互指向成环的环上成员 → cycle（循环）；
 *      仅仅指向环的非环成员不报循环。
 *
 * 核验只提示问题，不改变 CSV 导出；有未决冲突时不产出完整结论。
 *
 * 核心计算（最终保留行 + 问题清单）在 analyzeHierarchy 中，父子数据导入顺序
 * （src/order.js）共用同一份分析结果，保证两处判定完全一致。
 */

const { resolveRowProvenance } = require('./merge');

/** 问题类型 → 中文说明（JSON 结果中作为图例，页面展示也使用同一套文案） */
const ISSUE_TYPE_LABELS = {
  'missing-parent': '缺失父项（父键指向不存在或已删除的键）',
  cycle: '循环（父键指向自身或相互成环）',
};

/**
 * 校验父键列：必须给出、存在于表头、且不能是唯一键列。
 * @returns {string|null} 错误信息；合法时返回 null
 */
function validateParentColumn(model, parentColumn) {
  if (!parentColumn || typeof parentColumn !== 'string') {
    return '请求缺少 parentColumn（父键列）';
  }
  if (!model.headers.includes(parentColumn)) {
    return `父键列 "${parentColumn}" 不在表头中`;
  }
  if (parentColumn === model.keyColumn) {
    return '父键列不能与唯一键列相同';
  }
  return null;
}

/**
 * 在"每个节点至多一条父指针"的函数图上找出所有环上成员（迭代三色标记，
 * 避免长链递归爆栈）。自环是长度为 1 的环；仅仅指向环的节点不在环上，不计入。
 *
 * @param {string[]} keys 最终保留键
 * @param {Map<string,string>} parentOf 键 → 父键（仅含父键非空且父键存在的行）
 * @returns {Set<string>} 环上成员键
 */
function findCycleMembers(keys, parentOf) {
  const IN_PATH = 1;
  const DONE = 2;
  const state = new Map(); // 缺省 = 未访问；IN_PATH 只在单次遍历中存在
  const members = new Set();

  for (const start of keys) {
    if (state.get(start) === DONE) continue;
    const path = [];
    let cur = start;
    while (parentOf.has(cur)) {
      const s = state.get(cur);
      if (s === DONE) break; // 撞到已处理完的节点：本路径无新环
      if (s === IN_PATH) {
        // 在当前路径中再次遇到 → 从首次出现到路径末尾构成一个环
        for (let i = path.indexOf(cur); i < path.length; i++) members.add(path[i]);
        break;
      }
      state.set(cur, IN_PATH);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    for (const k of path) state.set(k, DONE);
  }
  return members;
}

/**
 * 层级分析：层级核验与父子数据导入顺序共用的基础计算。
 *
 * 按本轮模型与当前裁决算出最终保留行（与 CSV 导出、来源账本同一套
 * resolveRowProvenance），以最终唯一键建立索引，找出缺失父项与循环（仅环上成员）。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} parentColumn 父键列（调用前需先经 validateParentColumn 校验）
 * @returns {{
 *   unresolved: number, unresolvedDetails: string[],
 *   finalRows?: Array<{key:string, cells:string[], parentKey:string}>,
 *   issues?: Array<{key:string, parentKey:string, type:string, typeText:string, line:number}>,
 * }}
 *   有未决冲突时只返回 unresolved / unresolvedDetails（不给出完整结论）；
 *   否则 finalRows 按最终 CSV 行序（每行附原字符串父键，空串为根），
 *   issues 按最终 CSV 行序列出问题，line 为最终 CSV 的物理行号
 *   （表头为第 1 行，首行数据为第 2 行）。
 */
function analyzeHierarchy(model, decisions, parentColumn) {
  const parentIdx = model.headers.indexOf(parentColumn);
  const finalRows = [];
  const unresolvedDetails = [];

  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, model.headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
    if (res.deleted) continue;
    // 空字符串父键视为根；其余按原字符串保留（不裁剪空白）
    const pv = res.cells[parentIdx];
    finalRows.push({ key: res.key, cells: res.cells, parentKey: pv == null ? '' : pv });
  }

  // 未决冲突不得给出完整结论
  if (unresolvedDetails.length > 0) {
    return { unresolved: unresolvedDetails.length, unresolvedDetails };
  }

  // 以最终唯一键建立索引；行号 = 最终 CSV 物理行号（表头为第 1 行）
  const index = new Map();
  finalRows.forEach((r, i) => {
    if (!index.has(r.key)) index.set(r.key, i + 2);
  });

  // 父键非空且指向存在的最终键的行才参与环检测
  const parentOf = new Map();
  for (const r of finalRows) {
    if (r.parentKey === '') continue; // 空字符串父键视为根
    if (!index.has(r.parentKey)) continue; // 缺失父项，单独报告
    parentOf.set(r.key, r.parentKey);
  }
  const cycleMembers = findCycleMembers(
    finalRows.map((r) => r.key),
    parentOf,
  );

  const issues = [];
  finalRows.forEach((r, i) => {
    if (r.parentKey === '') return;
    let type = null;
    if (!index.has(r.parentKey)) type = 'missing-parent';
    else if (cycleMembers.has(r.key)) type = 'cycle';
    if (!type) return;
    issues.push({
      key: r.key,
      parentKey: r.parentKey,
      type,
      typeText: ISSUE_TYPE_LABELS[type],
      line: i + 2,
    });
  });

  return { unresolved: 0, unresolvedDetails: [], finalRows, issues };
}

/**
 * 生成父子层级核验结果。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} parentColumn 父键列（调用前需先经 validateParentColumn 校验）
 * @returns {{ check: object|null, unresolved: number, unresolvedDetails: string[] }}
 *   有未决冲突时 check 为 null（不给出完整结论）；
 *   check.issues 按最终 CSV 行序列出 { key, parentKey, type, typeText, line }，
 *   line 为最终 CSV 的物理行号（表头为第 1 行，首行数据为第 2 行）。
 */
function buildHierarchyCheck(model, decisions, parentColumn) {
  const a = analyzeHierarchy(model, decisions, parentColumn);
  if (a.unresolved > 0) {
    return { check: null, unresolved: a.unresolved, unresolvedDetails: a.unresolvedDetails };
  }

  const check = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    parentColumn,
    rowCount: a.finalRows.length,
    issueCount: a.issues.length,
    typeLegend: ISSUE_TYPE_LABELS,
    issues: a.issues,
  };
  return { check, unresolved: 0, unresolvedDetails: [] };
}

module.exports = {
  buildHierarchyCheck,
  analyzeHierarchy,
  validateParentColumn,
  findCycleMembers,
  ISSUE_TYPE_LABELS,
};
