'use strict';

/**
 * 父子数据导入顺序（parent-first import order）。
 *
 * 下游系统导入父子层级数据（分类、组织、菜单……）时，通常要求父行先于子行
 * 写入，否则子行的父键会悬空。冲突全部裁决后，本模块按本轮保存的模型与当前
 * 裁决算出最终保留行（与 CSV 导出、来源账本、层级核验共用 hierarchy.js 的
 * analyzeHierarchy），先核验再排序：
 *
 *  - 空父键视为根，其余父键按原字符串精确匹配最终唯一键；
 *  - 存在缺失父项或循环时：valid=false，keys / rows 均为 null——调用方必须
 *    阻止顺序导出（问题键与类型随 issues 列出）；原有合并 CSV 导出不受影响；
 *  - 层级有效时按父先子后排序：每步从当前可输出的行（父行已输出，或本身
 *    就是根）里选原合并 CSV 行序最早者（Kahn 算法 + 最小堆取原行下标），
 *    同层行的相对顺序尽量保持原行序。
 *
 * 顺序 CSV 沿用基准表头与原单元格值，仅行序重排；有未决冲突时不产出结论。
 */

const { analyzeHierarchy, ISSUE_TYPE_LABELS } = require('./hierarchy');

/**
 * 简单二叉最小堆（存放最终行的原行序下标），
 * 用于"每步从当前可输出的行里取原合并 CSV 行序最早者"。
 */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(x) {
    const a = this.items;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      const t = a[p];
      a[p] = a[i];
      a[i] = t;
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l] < a[s]) s = l;
        if (r < a.length && a[r] < a[s]) s = r;
        if (s === i) break;
        const t = a[s];
        a[s] = a[i];
        a[i] = t;
        i = s;
      }
    }
    return top;
  }
}

/**
 * 父先子后排序。
 *
 * 调用前提：层级有效（每个非空父键都存在于最终键中且无环）。此时每行恰好
 * 在父行输出后变为可输出，全部行都会被输出；每步从当前可输出的行里取
 * 原合并 CSV 行序（finalRows 下标）最早者。
 *
 * @param {Array<{key:string, cells:string[], parentKey:string}>} finalRows
 *   最终保留行（原合并 CSV 行序，analyzeHierarchy 的输出）
 * @returns {Array} 父先子后的行序（元素与传入相同，仅重排）
 */
function sortParentFirst(finalRows) {
  const children = new Map(); // 父键 → 子行下标（按原行序追加）
  const ready = new MinHeap(); // 当前可输出行的原行序下标
  for (let i = 0; i < finalRows.length; i++) {
    const pk = finalRows[i].parentKey;
    if (pk === '') {
      ready.push(i); // 空父键视为根：一开始即可输出
    } else {
      let list = children.get(pk);
      if (!list) children.set(pk, (list = []));
      list.push(i);
    }
  }
  const out = [];
  while (ready.size > 0) {
    const i = ready.pop(); // 当前可输出行中原行序最早者
    out.push(finalRows[i]);
    const kids = children.get(finalRows[i].key);
    if (kids) for (const k of kids) ready.push(k);
  }
  return out;
}

/**
 * 计算父子数据导入顺序。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} parentColumn 父键列（调用前需先经 validateParentColumn 校验）
 * @returns {{ order: object|null, rows: string[][]|null,
 *             unresolved: number, unresolvedDetails: string[] }}
 *   有未决冲突时 order / rows 均为 null；
 *   order.valid=false（存在缺失父项 / 循环）时 order.keys 与 rows 均为 null，
 *   问题键与类型在 order.issues 中（调用方应阻止顺序导出）；
 *   有效时 order.keys 为排序后的键序 [{ key, parentKey, line, mergedLine }]
 *   （line 为顺序 CSV 行号，mergedLine 为原合并 CSV 行号，表头均为第 1 行），
 *   rows 为同序的单元格行（供顺序 CSV 导出，逐格取值与合并 CSV 完全一致）。
 */
function buildImportOrder(model, decisions, parentColumn) {
  const a = analyzeHierarchy(model, decisions, parentColumn);
  if (a.unresolved > 0) {
    return {
      order: null,
      rows: null,
      unresolved: a.unresolved,
      unresolvedDetails: a.unresolvedDetails,
    };
  }

  const valid = a.issues.length === 0;
  const sorted = valid ? sortParentFirst(a.finalRows) : null;
  const mergedLineOf = new Map(a.finalRows.map((r, i) => [r.key, i + 2]));

  const order = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    parentColumn,
    rowCount: a.finalRows.length,
    issueCount: a.issues.length,
    valid,
    typeLegend: ISSUE_TYPE_LABELS,
    issues: a.issues,
    keys: sorted
      ? sorted.map((r, i) => ({
          key: r.key,
          parentKey: r.parentKey,
          line: i + 2,
          mergedLine: mergedLineOf.get(r.key),
        }))
      : null,
  };
  const rows = sorted ? sorted.map((r) => r.cells) : null;
  return { order, rows, unresolved: 0, unresolvedDetails: [] };
}

module.exports = { buildImportOrder, sortParentFirst };
