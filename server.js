'use strict';

/**
 * MQTT 桥接数据接收服务 (HTTP Sink)
 *
 * 配合 EMQX / 其它 MQTT 规则引擎的「HTTP 服务」动作使用：
 * 规则引擎把 C1/+/M 主题的消息 POST 到本服务，本服务把消息内容
 * 追加写入本地 txt 文件。
 *
 * 默认监听 0.0.0.0:18339，路由 POST /content，对应桥接配置里的
 * http://localhost:18339/content。
 */

const http = require('http');
const config = require('./config');
const FileLogger = require('./logger');

const logger = new FileLogger(config);

/** 读取请求体（带大小上限保护） */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/**
 * 从请求体中尽量解析出 topic 与 payload。
 * 兼容几种常见格式：
 *   1) {"topic":"C1/xxx/M","payload":{...}}
 *   2) {"topic":"...","payload":"原始字符串"}
 *   3) 任意 JSON（整体当作 payload，topic 从常见字段里猜）
 *   4) 非 JSON 原始字符串
 */
function parseRecord(raw, headerTopic) {
  const record = { topic: headerTopic || '', payload: undefined, raw };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    // 不是 JSON，整体作为原始 payload
    record.payload = raw;
    return record;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // 常见 topic 字段名
    record.topic =
      parsed.topic || parsed.Topic || parsed.channel || record.topic || '';
    // 常见 payload 字段名
    if ('payload' in parsed) record.payload = parsed.payload;
    else if ('data' in parsed) record.payload = parsed.data;
    else if ('message' in parsed) record.payload = parsed.message;
    else record.payload = parsed; // 没有明确 payload 字段，整体当 payload
  } else {
    record.payload = parsed;
  }
  return record;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 健康检查
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // 只接收指定路由的 POST
  if (url.pathname !== config.routePath) {
    sendJson(res, 404, { error: 'NOT_FOUND', path: url.pathname });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', method: req.method });
    return;
  }

  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (err) {
    if (err.message === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    } else {
      sendJson(res, 400, { error: 'BAD_REQUEST', detail: err.message });
    }
    return;
  }

  try {
    const headerTopic = req.headers['x-mqtt-topic'] || req.headers['topic'];
    const record = parseRecord(raw, headerTopic);
    const line = await logger.append(record);

    if (config.echoConsole) {
      console.log('[recv] ' + line);
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[error] 写入失败:', err);
    sendJson(res, 500, { error: 'WRITE_FAILED', detail: err.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `[start] MQTT 桥接接收服务已启动: http://${config.host}:${config.port}${config.routePath}`
  );
  console.log(`[start] 日志目录: ${config.logDir}`);
  console.log(`[start] 当前日志文件: ${logger.currentFilePath()}`);
});

// 优雅退出
function shutdown(signal) {
  console.log(`\n[stop] 收到 ${signal}，正在关闭服务...`);
  server.close(() => {
    console.log('[stop] 服务已关闭');
    process.exit(0);
  });
  // 兜底强退
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
