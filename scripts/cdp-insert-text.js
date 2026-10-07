/**
 * 通过 CDP 原生 Input.insertText 向已聚焦的输入框插入文本。
 * 目的：绕过 React 受控组件对 DOM value 赋值不响应的限制，
 *      Input.insertText 会被 React 的 onChange 正常捕获。
 *
 * 用法：node cdp-insert-text.js <targetId> <text>
 */
const TARGET = process.argv[2];
const TEXT = process.argv[3] || '';

if (!TARGET) {
  console.error('用法: node cdp-insert-text.js <targetId> <text>');
  process.exit(1);
}

async function main() {
  // 1. 通过 9222 找到目标 tab 的 webSocketDebuggerUrl
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await listRes.json();
  const tab = tabs.find((t) => t.id === TARGET || t.id.startsWith(TARGET));

  if (!tab) {
    console.error('未找到 target:', TARGET);
    console.error('可用:', tabs.map((t) => `${t.id.slice(0, 12)} ${t.title}`.slice(0, 60)).join('\n'));
    process.exit(2);
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
      setTimeout(() => {
        if (pending.has(msgId)) {
          pending.delete(msgId);
          reject(new Error(method + ' 超时'));
        }
      }, 10000);
    });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };

  await new Promise((r) => (ws.onopen = r));

  await send('Input.insertText', { text: TEXT });
  // 触发 keyup / change，React 需要 blur 才提交表单
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

  console.log('已插入:', JSON.stringify(TEXT));
  ws.close();
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});