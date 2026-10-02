'use strict';

/**
 * 业务数据落盘模块
 * - 负责把收到的消息追加写入本地 txt 文件
 * - 支持两级切分：按天分文件 + 单文件超过大小上限后滚动归档
 * - 自动清理：限制每个基名的归档份数，并清理超过保留天数的旧文件
 * - 使用串行化的追加写入，保证并发请求下写入不会交错错乱
 *
 * 文件命名示例（logPrefix=content, 按天滚动）：
 *   content-2026-10-02.txt       <- 当前写入
 *   content-2026-10-02.txt.1     <- 当天滚动归档（越大越旧）
 *   content-2026-10-02.txt.2
 *   content-2026-10-01.txt       <- 前一天
 */

const fs = require('fs');
const path = require('path');

class FileLogger {
  constructor(config) {
    this.config = config;
    this.writeChain = Promise.resolve(); // 串行写入队列，避免并发写交错
    this._ensureDir();
    // 启动时先做一次过期清理
    this._cleanupByRetention();
  }

  _ensureDir() {
    fs.mkdirSync(this.config.logDir, { recursive: true });
  }

  /** 日期后缀 YYYY-MM-DD */
  _dateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 根据配置生成当前应写入的文件完整路径 */
  currentFilePath() {
    const { logDir, logPrefix, rotateDaily } = this.config;
    if (!rotateDaily) {
      return path.join(logDir, `${logPrefix}.txt`);
    }
    return path.join(logDir, `${logPrefix}-${this._dateStr()}.txt`);
  }

  /**
   * 追加一行记录。
   * @param {object} record { topic, payload, raw }
   * @returns {Promise<string>} 实际写入的文本行（不含结尾换行）
   */
  append(record) {
    const line = this._formatLine(record);

    // 把本次写入挂到串行队列尾部，保证顺序执行（滚动与写入不会交错）
    this.writeChain = this.writeChain.then(() => this._writeOne(line));

    return this.writeChain.then(() => line.replace(/\n$/, ''));
  }

  /** 实际执行一次写入：必要时先滚动，再追加 */
  async _writeOne(line) {
    const file = this.currentFilePath();
    await this._rotateIfNeeded(file, Buffer.byteLength(line, 'utf8'));
    await fs.promises.appendFile(file, line, 'utf8');
  }

  /**
   * 如果当前文件写入后会超过大小上限，则先把它滚动归档：
   * file.(n) -> file.(n+1) ... file -> file.1，然后写入全新的 file。
   */
  async _rotateIfNeeded(file, incomingBytes) {
    const { maxFileBytes } = this.config;
    if (!maxFileBytes || maxFileBytes <= 0) return; // 关闭大小滚动

    let size = 0;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch (_) {
      return; // 文件还不存在，无需滚动
    }

    // 当前文件为空却仍超限（单行超过上限）时不滚动，避免产生空文件死循环
    if (size === 0) return;
    if (size + incomingBytes <= maxFileBytes) return;

    await this._rollFiles(file);
    await this._cleanupBackups(file);
  }

  /** 把 file.N -> file.(N+1)，最后 file -> file.1 */
  async _rollFiles(file) {
    const existing = this._backupIndexes(file).sort((a, b) => b - a); // 从大到小
    for (const n of existing) {
      await fs.promises
        .rename(`${file}.${n}`, `${file}.${n + 1}`)
        .catch(() => {});
    }
    await fs.promises.rename(file, `${file}.1`).catch(() => {});
  }

  /** 列出 file 对应的所有归档序号 [1,2,3...] */
  _backupIndexes(file) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return [];
    }
    const prefix = base + '.';
    const out = [];
    for (const name of names) {
      if (name.startsWith(prefix)) {
        const suffix = name.slice(prefix.length);
        if (/^\d+$/.test(suffix)) out.push(parseInt(suffix, 10));
      }
    }
    return out;
  }

  /** 超过 maxBackups 的归档删掉最旧的（序号最大的） */
  async _cleanupBackups(file) {
    const { maxBackups } = this.config;
    if (!maxBackups || maxBackups <= 0) return; // 不限制

    // maxBackups 含当前文件，所以最多保留 maxBackups-1 个 .N 归档
    const keep = Math.max(0, maxBackups - 1);
    const indexes = this._backupIndexes(file).sort((a, b) => a - b);
    const toDelete = indexes.filter((n) => n > keep);
    for (const n of toDelete) {
      await fs.promises.unlink(`${file}.${n}`).catch(() => {});
    }
  }

  /** 清理超过 retentionDays 的旧日志（按文件修改时间） */
  _cleanupByRetention() {
    const { retentionDays, logDir, logPrefix, rotateDaily } = this.config;
    if (!rotateDaily) return; // 不按天滚动时此清理不适用
    if (!retentionDays || retentionDays <= 0) return;

    let names = [];
    try {
      names = fs.readdirSync(logDir);
    } catch (_) {
      return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const prefix = `${logPrefix}-`;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(logDir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) {
        /* 忽略单个文件错误 */
      }
    }
  }

  _formatLine(record) {
    const parts = [];
    if (this.config.withTimestamp) {
      parts.push(`[${new Date().toISOString()}]`);
    }
    if (record.topic) {
      parts.push(`topic=${record.topic}`);
    }
    // payload 统一序列化成单行字符串
    let payloadStr;
    if (typeof record.payload === 'string') {
      payloadStr = record.payload;
    } else if (record.payload !== undefined) {
      payloadStr = JSON.stringify(record.payload);
    } else {
      payloadStr = record.raw ?? '';
    }
    // 去掉内部换行，保证一条消息一行，便于后续按行解析
    payloadStr = String(payloadStr).replace(/\r?\n/g, '\\n');
    parts.push(`payload=${payloadStr}`);

    return parts.join(' ') + '\n';
  }
}

module.exports = FileLogger;
