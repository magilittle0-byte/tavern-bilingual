const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./core.js');
const dir = __dirname;
const content = ['core.js', 'runtime.js'].map(p => fs.readFileSync(path.join(dir, p), 'utf8')).join('\n');
const script = {
  type: 'script', enabled: true, name: `双语正文 · 中文阅读 ${C.version}（未验收候选）`,
  id: 'b50145ee-0f19-4735-b7ec-3c3b9fb6b7d3', content,
  info: '首次加载自动打开设置；也可点击屏幕右侧“翻译设置”或扩展区“双语正文 · 中文阅读”。日文保留原始楼层，中文仅显示。先导入配套正则。支持当前 API、连接配置、独立 API。默认自动翻译关闭，尚未完成真实门禁。',
  button: { enabled: true, buttons: [{ name: '双语正文设置', visible: true }] }, data: {},
  export_with: { data: false, button: true },
};
fs.writeFileSync(path.join(dir, '双语正文-酒馆助手.json'), JSON.stringify(script, null, 2) + '\n');
fs.writeFileSync(path.join(dir, '隐藏外语原文-仅显示正则.json'), JSON.stringify(C.regex, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'tavern-bilingual.json'), JSON.stringify(script, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'hide-original.regex.json'), JSON.stringify(C.regex, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'candidate-manifest.json'), JSON.stringify({ version: C.version,
  scriptSha256: crypto.createHash('sha256').update(content).digest('hex'), realAcceptance: false,
  reason: 'Candidate only. Full real-Tavern acceptance with the model and companion extensions has not been completed.',
}, null, 2) + '\n');
console.log('Built importable script + display-only regex; realAcceptance=false.');
