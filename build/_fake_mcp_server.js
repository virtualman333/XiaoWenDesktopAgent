/**
 * 极简 MCP 服务器（仅用于联调测试）：stdio 传输，提供 ping / echo 两个工具。
 */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function handle(m) {
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } });
  } else if (m.method === 'notifications/initialized') {
    // 通知，无需回执
  } else if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: m.id,
      result: {
        tools: [
          { name: 'ping', description: '返回 pong', inputSchema: { type: 'object', properties: {} } },
          { name: 'echo', description: '回显一段文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
        ]
      }
    });
  } else if (m.method === 'tools/call') {
    const a = (m.params && m.params.arguments) || {};
    const out = m.params && m.params.name === 'echo' ? ('echo: ' + (a.text || '')) : 'pong from fake-mcp';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: out }] } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
}
