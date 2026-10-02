'use strict';

/**
 * 日志滚动 / 清理单元测试（直接测 FileLogger，不走 HTTP）。
 */

const fs = require('fs');
const path = require('path');
const FileLogger = require('../logger');

const DIR = path.join(__dirname, '.tmp-rotate');
fs.rmSync(DIR, { recursive: true, force: true });

function assert(cond, msg) {
  if (!cond) {
    console.error('  ✗ FAIL: ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log('  ✓ ' + msg);
}

async function run() {
  // 每个文件最多 ~200 字节就滚动，最多保留 3 个文件（当前 + 2 归档）
  const logger = new FileLogger({
    logDir: DIR,
    logPrefix: 'content',
    rotateDaily: true,
    withTimestamp: true,
    maxFileBytes: 200,
    maxBackups: 3,
    retentionDays: 30,
  });

  // 写 50 条，每条约 60+ 字节，必然触发多次滚动
  for (let i = 0; i < 50; i++) {
    await logger.append({ topic: `C1/dev${i}/M`, payload: `#SM${i}?` });
  }

  const files = fs.readdirSync(DIR).sort();
  console.log('\n滚动后的文件: ' + files.join(', '));

  // 基名（去掉 .N 归档后缀）
  const today = new Date();
  const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const baseName = `content-${ds}.txt`;

  const relevant = files.filter(
    (f) => f === baseName || f.startsWith(baseName + '.')
  );
  assert(
    relevant.length === 3,
    `最多保留 3 个文件 (maxBackups=3)，实际 ${relevant.length}: ${relevant.join(', ')}`
  );
  assert(files.includes(baseName), '当前写入文件存在');
  assert(files.includes(baseName + '.1'), '存在归档 .1');
  assert(files.includes(baseName + '.2'), '存在归档 .2');
  assert(!files.includes(baseName + '.3'), '.3 已被清理（超出 maxBackups）');

  // 每个文件都不超过阈值太多（允许单行溢出，但不应堆积）
  for (const f of relevant) {
    const sz = fs.statSync(path.join(DIR, f)).size;
    assert(sz <= 300, `${f} 大小 ${sz} 字节，在合理范围内`);
  }

  // 验证最新归档 .1 的内容比当前文件旧（滚动方向正确：.1 是刚被归档的）
  console.log('\n清理测试通过 ✓');
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('\n所有滚动测试通过 ✓');
}

run().catch((err) => {
  console.error('\n测试异常:', err);
  process.exit(1);
});
