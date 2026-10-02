'use strict';

/**
 * 自测脚本：无需外部 MQTT broker。
 * 启动服务 -> 用 http 客户端模拟桥接端发送几种格式的消息 ->
 * 读回 txt 文件校验内容。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 使用独立的测试目录，避免污染真实 data 目录
const TEST_DIR = path.join(__dirname, '.tmp-data');
process.env.LOG_DIR = TEST_DIR;
process.env.PORT = '0'; // 让系统分配空闲端口
process.env.ECHO_CONSOLE = 'false';

// 清理旧的测试数据
fs.rmSync(TEST_DIR, { recursive: true, force: true });

const config = require('../config');
const server = require('../server');

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: config.routePath,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error('  ✗ FAIL: ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log('  ✓ ' + msg);
}

async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`测试服务端口: ${port}\n`);

  // 1) 标准格式: topic + 对象 payload
  let r = await post(port, { topic: 'C1/device01/M', payload: { temp: 25.3, humi: 60 } });
  assert(r.status === 200, '标准消息返回 200');

  // 2) payload 为字符串
  r = await post(port, { topic: 'C1/device02/M', payload: 'raw-string-value' });
  assert(r.status === 200, '字符串 payload 返回 200');

  // 3) 没有 payload 字段，整体当 payload；topic 从 header 取
  r = await post(port, { foo: 'bar', n: 1 }, { 'x-mqtt-topic': 'C1/device03/M' });
  assert(r.status === 200, '无 payload 字段 + header topic 返回 200');

  // 4) 非 JSON 原始字符串
  r = await post(port, 'plain text body', { 'content-type': 'text/plain' });
  assert(r.status === 200, '非 JSON 原始字符串返回 200');

  // 5) 错误路由
  r = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/wrong', method: 'POST' },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.end('{}');
  });
  assert(r.status === 404, '错误路由返回 404');

  // 等待写入队列 flush
  await new Promise((r) => setTimeout(r, 200));

  // 校验文件内容
  const files = fs.readdirSync(TEST_DIR);
  assert(files.length === 1, `生成了 1 个日志文件 (实际: ${files.join(', ')})`);
  const content = fs.readFileSync(path.join(TEST_DIR, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  console.log('\n写入的文件内容:\n' + content);

  assert(lines.length === 4, `文件共 4 行有效记录 (实际 ${lines.length})`);
  assert(/topic=C1\/device01\/M/.test(content), '包含 device01 的 topic');
  assert(/"temp":25.3/.test(content), '包含对象 payload 的 temp 字段');
  assert(/payload=raw-string-value/.test(content), '包含字符串 payload');
  assert(/topic=C1\/device03\/M/.test(content), 'header topic 被正确记录');
  assert(/payload=plain text body/.test(content), '非 JSON 原始内容被记录');
  assert(/^\[\d{4}-\d{2}-\d{2}T/.test(lines[0]), '每行带 ISO 时间戳');

  console.log('\n所有测试通过 ✓');
  server.close(() => process.exit(process.exitCode || 0));
}

run().catch((err) => {
  console.error('\n测试异常:', err);
  server.close(() => process.exit(1));
});
