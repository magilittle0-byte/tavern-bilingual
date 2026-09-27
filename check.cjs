/* Synthetic checks only. This is NOT real Tavern / model acceptance. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'); }
catch { playwright = require(path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const { chromium } = playwright;
const C = require('./core.js');

async function main() {
  let passed = 0;
  const check = (value, message) => { assert.ok(value, message); passed++; };
  const source = '<content><bt-original>雨が降る。\n「行こう」</bt-original></content>\n<UpdateVariable>{"x":1}</UpdateVariable>\n<tableEdit>updateRow(0,0,{"0":"甲"})</tableEdit><options>1. 等待</options>';
  const r = C.parse(source);
  const output = C.render(source, r, ['雨落了。\n“走吧。”']);
  check(output.endsWith(source.slice(r[0].end)), 'All non-narrative bytes must remain intact.');
  check(C.split(('あ'.repeat(3499) + '😀\n').repeat(3)).join('') === ('あ'.repeat(3499) + '😀\n').repeat(3), 'Chunking preserves Unicode source.');
  for (const invalid of ['<bt-original>text', '<bt-original><UpdateVariable>x</UpdateVariable></bt-original>', '<bt-original>```js\na()\n```</bt-original>', '<bt-original>insertRow(1)</bt-original>', '<bt-original><bt-original>x</bt-original></bt-original>', '<think><bt-original>非正文</bt-original></think>', '<script>let x="<bt-original>程序文本</bt-original>";</script>']) {
    assert.throws(() => C.parse(invalid)); passed++;
  }
  assert.throws(() => C.parseReply('{"translation":"unfinished')); passed++;
  check(C.parseReply('{"translation":"<img src=x onerror=alert(1)> {{user}}"}').includes('&lt;img'), 'Translated HTML must be inert.');
  const hide = new RegExp(C.regex.findRegex.slice(1, -3), 'gi');
  check(!source.replace(hide, C.regex.replaceString).includes('雨が'), 'Complete original is hidden.');
  check(!'<content><bt-original>雨が降る'.replace(hide, C.regex.replaceString).includes('雨が'), 'Unclosed streaming original is hidden.');
  check('<bt-original>雨<UpdateVariable>x</UpdateVariable>'.replace(hide, C.regex.replaceString).includes('<UpdateVariable>x'), 'Malformed wrapper must not consume known data block.');
  check(C.regex.markdownOnly && !C.regex.promptOnly && C.regex.placement.join() === '2', 'Regex is display-only, AI-only.');

  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><body><div id="qr--bar" style="display:none"></div><main id="chat"></main></body>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
    const page = await browser.newPage({ viewport: { width: 750, height: 900 } });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(({ source, regex }) => {
      const events = new Map();
      window.tavern_events = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED'].map(k => [k, k]));
      window.eventOn = (type, fn) => { const set = events.get(type) || new Set(); set.add(fn); events.set(type, set); return { stop: () => set.delete(fn) }; };
      window.emit = async (type, ...args) => { for (const fn of [...(events.get(type) || [])]) await fn(...args); };
      window.getButtonEvent = name => name;
      window.replaceScriptButtons = () => { throw Error('Synthetic: Helper QR button unavailable'); };
      window.vars = {}; window.getVariables = () => vars;
      window.updateVariablesWith = fn => { vars = fn(vars); };
      window.regexReady = true;
      window.getTavernRegexes = () => regexReady ? [{ id: 'native-importer-generated-id', enabled: true, find_regex: regex.findRegex, replace_string: regex.replaceString, source: { ai_output: true }, destination: { display: true, prompt: false } }] : [];
      window.injected = [];
      window.injectPrompts = prompts => { injected = prompts; };
      window.uninjectPrompts = () => { injected = []; };
      window.requests = []; window.deferred = false; window.waiters = []; window.failNext = false;
      window.generateRaw = () => { throw Error('Forbidden helper generation path.'); };
      window.requestTranslation = async payload => {
        requests.push(payload);
        if (deferred) return new Promise(resolve => waiters.push(resolve));
        if (failNext) { failNext = false; throw Error('synthetic provider error'); }
        return JSON.stringify({ translation: '雨落了。\n“走吧。”' });
      };
      // Intentionally do not resolve cancelled requests: test stale response guards too.
      window.saved = []; window.refreshes = [];
      window.context = { chat: [{ is_user: false, mes: source, swipe_id: 0, extra: { stat_data: { hp: 7 }, acu: { rows: ['kept'] } } }], chatId: 'chat-a', characterId: 3, mainApi: 'openai',
        getChatCompletionModel: () => 'synthetic-current-model',
        ChatCompletionService: {
          presetToGeneratePayload: async (p, overrides, payload) => ({ chat_completion_source: 'openai', tools: ['must-remove'], char_name: 'must-remove', ...payload }),
          processRequest: async payload => ({ content: await requestTranslation(payload) }),
        },
        extensionSettings: { disabledExtensions: [], connectionManager: { profiles: [{ id: 'p1', name: '翻译专用连接' }] } },
        saveChat: async () => { saved.push(context.chatId); },
        updateMessageBlock: (index, m) => { refreshes.push(index); document.querySelector('#chat').textContent = m.extra.display_text || m.mes; },
        ConnectionManagerRequestService: { sendRequest: async (...args) => { window.profileArgs = args; return { content: '{"translation":"连接配置译文"}' }; } },
      };
      window.SillyTavern = { getContext: () => context };
    }, { source, regex: C.regex });
    const importContent = JSON.parse(fs.readFileSync(path.join(__dirname, '双语正文-酒馆助手.json'))).content;
    await page.evaluate(content => {
      const iframe = document.createElement('iframe'); iframe.id = 'TH-script--synthetic-bilingual'; iframe.style.display = 'none';
      const names = ['tavern_events','eventOn','getButtonEvent','replaceScriptButtons','getVariables','updateVariablesWith','getTavernRegexes','injectPrompts','uninjectPrompts'];
      const predefine = names.map(name => `window.${name}=parent.${name};`).join('\n');
      iframe.srcdoc = '<!doctype html><html><body><script>' + predefine + '</script><script type="module">' + content + '</script></body></html>';
      document.body.append(iframe);
    }, importContent);
    await page.getByRole('dialog', { name: '双语正文设置' }).waitFor({ state: 'visible' });
    check(await page.evaluate(() => document.querySelector('iframe').style.display === 'none' && !!document.querySelector('dialog[open]')), 'Settings auto-open in visible host from hidden Helper iframe.');
    check(await page.locator('[name=route]').isVisible(), 'First-load settings show the provider selector without a Helper QR button.');
    check(await page.evaluate(() => requests.length === 0), 'Opening the settings does not generate a model request.');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '双语正文设置', exact: true }).click();
    check(await page.getByRole('dialog', { name: '双语正文设置' }).isVisible(), 'Visible launcher opens settings via a user click.');
    await page.locator('[name=enabled]').check();
    await page.evaluate(() => { regexReady = false; });
    await page.locator('[data-save]').click();
    check((await page.locator('[data-status]').innerText()).includes('正则'), 'Cannot enable without the original-hiding regex.');
    await page.evaluate(() => { regexReady = true; });
    await page.locator('[data-save]').click();
    await page.screenshot({ path: path.join(__dirname, 'settings-preview.png') });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => { const box = document.createElement('div'); box.id = 'extensions_settings2'; document.body.append(box); });
    await page.getByRole('button', { name: '打开双语正文设置', exact: true }).click();
    check(await page.getByRole('dialog', { name: '双语正文设置' }).isVisible(), 'Late-mounted extension settings entry opens the panel.');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => {
      document.querySelector('#extensions_settings2').replaceChildren();
      document.querySelector('#tavern_bilingual_v1_launcher').remove();
    });
    await page.getByRole('button', { name: '打开双语正文设置', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '双语正文设置', exact: true }).waitFor({ state: 'visible' });
    check(await page.locator('#tavern_bilingual_v1_launcher').count() === 1 && await page.locator('#tavern_bilingual_v1_settings_entry').count() === 1, 'DOM replacement restores one copy of each entrance.');
    await page.screenshot({ path: path.join(__dirname, 'settings-entry-preview.png') });
    await page.evaluate(async () => {
      await emit('GENERATION_STARTED', 'normal', {}, false);
      await emit('GENERATION_AFTER_COMMANDS', 'normal', { quiet_prompt: undefined }, false);
    });
    check((await page.evaluate(() => injected[0].content)).includes('日本語'), 'Inject source-language instruction on normal generation.');
    await page.evaluate(() => emit('GENERATION_ENDED', 1));
    await page.waitForFunction(() => saved.length === 1);
    const normal = await page.evaluate(() => ({ raw: context.chat[0].mes, extra: context.chat[0].extra, request: requests[0], count: requests.length }));
    check(normal.raw === source, 'Translation must not overwrite database/history input.');
    check(normal.extra.stat_data.hp === 7 && normal.extra.acu.rows[0] === 'kept', 'MVU and DB-owned fields remain intact.');
    check(normal.extra.display_text.includes('雨落了') && !normal.extra.display_text.includes('雨が'), 'Only Chinese narrative displays.');
    check(!normal.request.stream && normal.request.messages.length === 2 && !normal.request.tools && !normal.request.char_name, 'Independent request excludes fiction tools, identity and history.');
    check(!normal.request.messages[1].content.includes('UpdateVariable') && !normal.request.messages[1].content.includes('updateRow'), 'System blocks must not be sent for translation.');
    await page.evaluate(() => emit('GENERATION_ENDED', 1));
    await page.waitForTimeout(800);
    check(await page.evaluate(() => requests.length === 1), 'Duplicate generation end must not translate twice.');

    // Old translation finishes after changing chats: it must neither write nor save.
    await page.evaluate(async () => {
      deferred = true;
      context.chat[0].mes = context.chat[0].mes.replace('雨が降る', '風が吹く');
      await emit('MESSAGE_EDITED', 0);
    });
    await page.waitForFunction(() => waiters.length === 1);
    await page.evaluate(async () => {
      context.chat = [{ is_user: false, mes: '<bt-original>別の会話</bt-original>', swipe_id: 0, extra: { acu: 'other' } }];
      context.chatId = 'chat-b';
      await emit('CHAT_CHANGED');
      waiters.shift()('{"translation":"过期译文"}'); deferred = false;
    });
    await page.waitForTimeout(150);
    check(await page.evaluate(() => context.chat[0].extra.display_text === undefined && saved.length === 1), 'Late reply cannot write/save a different chat.');

    // Start another translation, then switch swipe and update DB state while it runs.
    await page.evaluate(() => { deferred = true; });
    await page.evaluate(() => emit('MESSAGE_EDITED', 0));
    await page.waitForFunction(() => waiters.length === 1);
    await page.evaluate(async () => {
      context.chat[0].swipe_id = 1; context.chat[0].mes = '<bt-original>新しい返答</bt-original><tableEdit>KEEP</tableEdit>';
      context.chat[0].extra.acu = 'new-db-value';
      await emit('MESSAGE_SWIPED', 0);
      deferred = false; waiters.shift()('{"translation":"旧 swipe 的译文"}');
    });
    await page.waitForFunction(() => saved.length === 2);
    check(await page.evaluate(() => context.chat[0].extra.acu === 'new-db-value' && !context.chat[0].extra.display_text.includes('旧 swipe')), 'Swipe race preserves fresh DB state and rejects stale translation.');

    await page.getByRole('button', { name: '双语正文设置', exact: true }).click();
    await page.locator('[name=route]').selectOption('profile');
    await page.locator('[name=profileId]').selectOption('p1');
    await page.locator('[data-save]').click();
    await page.locator('[data-retry]').click();
    await page.waitForFunction(() => !!window.profileArgs);
    check(await page.evaluate(() => profileArgs[0] === 'p1' && profileArgs[3].includePreset === false && profileArgs[3].includeInstruct === false), 'Saved profile uses its connection without fiction prompts.');
    await page.waitForFunction(() => saved.length === 3);
    await page.locator('[name=route]').selectOption('custom');
    await page.locator('[name=apiurl]').fill('https://example.invalid/v1');
    await page.locator('[name=model]').fill('synthetic-model');
    await page.locator('[name=key]').fill('synthetic-secret-not-a-real-key');
    await page.locator('[data-save]').click();
    await page.locator('[data-retry]').click();
    await page.waitForFunction(() => saved.length === 4);
    check(await page.evaluate(() => !JSON.stringify(vars).includes('synthetic-secret') && requests.at(-1).proxy_password === 'synthetic-secret-not-a-real-key'), 'Custom key is session-only and passed only to selected request.');
    await page.evaluate(() => { failNext = true; });
    const beforeFailure = await page.evaluate(() => requests.length);
    await page.locator('[data-retry]').click();
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('请求失败'));
    await page.waitForTimeout(750);
    check(await page.evaluate(n => requests.length === n + 1 && saved.length === 4, beforeFailure), 'Failed request cannot cause retries or save a fake success.');
    await page.locator('[data-original]').click();
    check(await page.evaluate(() => context.chat[0].extra.display_text.includes('新しい返答') && !context.chat[0].extra.display_text.includes('<bt-original>')), 'Original toggle bypasses only the narrative-hide marker.');
    const beforeQuiet = await page.evaluate(() => requests.length);
    await page.evaluate(async () => { await emit('GENERATION_STARTED', 'quiet', {}, false); await emit('GENERATION_AFTER_COMMANDS', 'quiet', {}, false); await emit('GENERATION_ENDED', 1); });
    await page.waitForTimeout(750);
    check(await page.evaluate(n => requests.length === n && injected.length === 0, beforeQuiet), 'Quiet/background generation cannot trigger translation or language injection.');
    await page.evaluate(() => emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false));
    check(await page.evaluate(() => injected.length === 0), 'Helper normal event cannot inject narrative prompt.');
    await page.evaluate(async () => {
      await emit('GENERATION_STARTED', 'normal', {}, false);
      await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    });
    check(await page.evaluate(() => injected.length === 0), 'Helper cannot consume native prompt slot during foreground generation.');
    await page.evaluate(async () => {
      await emit('GENERATION_STOPPED', 'foreign-helper-request-id');
      await emit('GENERATION_AFTER_COMMANDS', 'normal', { quiet_prompt: undefined }, false);
    });
    check(await page.evaluate(() => injected.length === 1), 'Foreign helper cancellation cannot stop foreground prompt handling.');
    await page.evaluate(() => emit('GENERATION_STOPPED'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(__dirname, 'settings-mobile-preview.png') });
    check(await page.locator('dialog').evaluate(el => el.getBoundingClientRect().width <= innerWidth), 'Settings panel fits a mobile viewport.');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '双语正文设置', exact: true }).click();
    check(await page.getByRole('dialog', { name: '双语正文设置' }).isVisible(), 'Launcher is clickable on a phone-size viewport.');
    await page.evaluate(() => document.querySelector('iframe').remove());
    await page.waitForFunction(() => !window.tavern_bilingual_v1);
    check(await page.evaluate(() => !window.tavern_bilingual_v1 && injected.length === 0), 'Dispose removes owned listeners and prompt.');
    check(await page.locator('#tavern_bilingual_v1_launcher,#tavern_bilingual_v1_settings_entry,#tavern_bilingual_v1_panel').count() === 0, 'Iframe unload removes the host settings UI.');
    const report = { passed, evidence: 'synthetic_local_only', realAcceptance: false, testedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'local-check-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
