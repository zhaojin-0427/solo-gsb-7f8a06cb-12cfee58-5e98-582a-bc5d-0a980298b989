'use strict';

/**
 * RFC 4180 风格的 CSV 解析 / 序列化。
 * 解析结果保留每条记录在源文件中的起始物理行号（表头为第 1 行），
 * 被引号包裹的字段可以包含换行。
 */

/**
 * @param {string} text
 * @returns {{headers: string[], rows: Array<{line:number, cells:string[]}>, errors: Array<{line:number|null, message:string}>}}
 */
function parseCSV(text) {
  const errors = [];

  // 去掉 UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  /** @type {Array<{line:number, cells:string[]}>} */
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let recordHasContent = false;
  let line = 1;
  let recordStartLine = 1;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const endRecord = () => {
    records.push({ line: recordStartLine, cells: row });
    row = [];
    recordHasContent = false;
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      if (ch === '\n') {
        line++;
      } else if (ch === '\r') {
        line++;
        if (text[i + 1] === '\n') {
          field += '\n';
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      recordHasContent = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      recordHasContent = true;
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      i++;
      // 跳过空行（引号外的纯空白行）
      if (!recordHasContent && field === '' && row.length === 0) {
        recordStartLine = line;
        continue;
      }
      pushField();
      endRecord();
      recordStartLine = line;
      continue;
    }

    field += ch;
    recordHasContent = true;
    i++;
  }

  if (inQuotes) {
    errors.push({ line: recordStartLine, message: '引号未闭合：字段中的引号必须写成两个双引号（""）' });
  } else if (recordHasContent || field !== '' || row.length > 0) {
    pushField();
    endRecord();
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push({ line: null, message: '文件为空或没有表头' });
    return { headers: [], rows: [], errors };
  }
  if (records.length === 0) {
    return { headers: [], rows: [], errors };
  }

  const headerRecord = records[0];
  const headers = headerRecord.cells;

  headers.forEach((h, idx) => {
    if (h.trim() === '') {
      errors.push({ line: 1, message: `第 ${idx + 1} 列表头为空` });
    }
  });
  const seen = new Map();
  headers.forEach((h) => {
    seen.set(h, (seen.get(h) || 0) + 1);
  });
  for (const [h, count] of seen) {
    if (count > 1) errors.push({ line: 1, message: `表头列名 "${h}" 重复出现 ${count} 次` });
  }

  const rows = records.slice(1);
  for (const rec of rows) {
    if (rec.cells.length !== headers.length) {
      errors.push({
        line: rec.line,
        message: `列数不一致：期望 ${headers.length} 列，实际 ${rec.cells.length} 列`,
      });
    }
  }

  return { headers, rows, errors };
}

/**
 * 三份文件表头一致性校验，返回带文件名的错误列表。
 * @returns {Array<{file:string, line:number|null, message:string}>}
 */
function checkHeadersConsistency(parsed) {
  const errors = [];
  const base = parsed.base;
  for (const label of ['local', 'remote']) {
    const cur = parsed[label];
    if (base.headers.length !== cur.headers.length) {
      errors.push({
        file: label,
        line: 1,
        message: `表头与基准不一致：基准有 ${base.headers.length} 列，本文件有 ${cur.headers.length} 列`,
      });
      continue;
    }
    const diffs = [];
    for (let i = 0; i < base.headers.length; i++) {
      if (base.headers[i] !== cur.headers[i]) {
        diffs.push(`第 ${i + 1} 列：基准="${base.headers[i]}"，本文件="${cur.headers[i]}"`);
      }
    }
    if (diffs.length > 0) {
      errors.push({ file: label, line: 1, message: `表头与基准不一致：${diffs.join('；')}` });
    }
  }
  return errors;
}

/** @param {string} value */
function needsQuote(value) {
  return /[",\r\n]/.test(value);
}

/**
 * @param {string[][]} rows
 * @returns {string}
 */
function stringifyCSV(rows) {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const v = cell == null ? '' : String(cell);
          return needsQuote(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(','),
    )
    .join('\r\n');
}

module.exports = { parseCSV, checkHeadersConsistency, stringifyCSV };
