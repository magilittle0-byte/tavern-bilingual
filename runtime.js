/* Requires Tavern Helper. Built together with core.js; no remote script loader. */
(() => {
  'use strict';
  const C = BilingualCore, KEY = 'tavern_bilingual_v1';
  const host = window.parent, doc = host.document;
  const ctx = () => host.SillyTavern.getContext();
  if (host[KEY]?.dispose) host[KEY].dispose();
  let savedSettings, startupError = '';
  try { savedSettings = getVariables({ type: 'script' })[KEY]; }
  catch { startupError = '未能读取酒馆助手脚本设置，请重新启用脚本或检查酒馆助手版本。'; }
  let settings = { ...C.defaults, ...savedSettings };
  let epoch = 0, active = null, pending = null, timer = null, disposed = false;
  let running = false, foreground = false, awaitingPrompt = false, cancelled = false, generationChat = null;
  let sessionKey = '', panel = null, status = startupError || (settings.enabled ? '自动翻译已启用。' : '未启用；请先配置翻译连接。');
  let launcher = null, extensionEntry = null, mountObserver = null, mountTimer = null, welcomeTimer = null;
  const listeners = [], buttons = [];
  const notices = {
    NO_MARKER: '未找到正文标记；原文未修改。请检查预设是否覆盖了语言要求。',
    BROKEN_MARKER: '正文标记未闭合；为保护系统数据，未翻译。',
    STRUCTURED_BODY: '正文标记中混入了代码或系统结构；未翻译。',
    SOURCE_SIZE: '消息过长，未翻译。',
    INVALID_JSON: '译文格式不完整或被截断；可增加输出上限后手动重译。',
    EMPTY_TRANSLATION: '接口返回空译文。', NON_TEXT_REPLY: '接口未返回文本。',
    DISPLAY_CONFLICT: '检测到其他插件已占用显示译文；未覆盖。请关闭其他自动翻译。',
    PROFILE_MISSING: '找不到所选连接配置；请重新选择。',
    API_CONFIG: '请填写有效的独立 API 地址和模型。',
    SERVICE_MISSING: '此宿主缺少独立请求接口；当前连接需为 Chat Completion。可选择受支持的连接配置。',
    REGEX_MISSING: '请先导入配套隐藏正则，并将它放在显示正则的前面。',
    API_FAILED: '翻译请求失败；原文保留。请检查连接后手动重译。',
  };
  function notify(text) {
    status = text;
    const el = panel?.querySelector('[data-status]');
    if (el) el.textContent = text;
    const hint = extensionEntry?.querySelector('[data-entry-status]');
    if (hint) hint.textContent = text;
    if (launcher) launcher.title = '双语正文设置 — ' + text;
  }
  function on(type, fn) {
    if (type) listeners.push(eventOn(type, fn));
  }
  function abortOwn() {
    pending = null; clearTimeout(timer); epoch++;
    if (active) {
      active.controller.abort();
    }
  }
  function removePrompt() {
    try { if (typeof uninjectPrompts === 'function') uninjectPrompts([KEY]); } catch { /* Cleanup must still remove the UI when Helper is unloading. */ }
  }
  function hasRegex() {
    try {
      return !ctx().extensionSettings?.disabledExtensions?.includes('regex') &&
        // The native importer regenerates IDs. Match the display rule's semantics.
        getTavernRegexes({ type: 'global' }).some(r => r.enabled &&
          r.find_regex === C.regex.findRegex && r.replace_string === C.regex.replaceString &&
          r.destination?.display && !r.destination?.prompt && r.source?.ai_output &&
          !r.source?.user_input && !r.source?.world_info && !r.source?.reasoning &&
          r.min_depth == null && r.max_depth == null);
    } catch { return false; }
  }
  function setDisplay(target, text) {
    const now = ctx();
    if (!C.isCurrent(now, target, epoch)) return false;
    const extra = target.message.extra ??= {};
    const owned = extra[KEY];
    if (extra.display_text != null && (!owned || extra.display_text !== owned.display)) throw C.failure('DISPLAY_CONFLICT');
    extra.display_text = text;
    extra[KEY] = { ...(owned || {}), display: text };
    now.updateMessageBlock(target.index, target.message);
    return true;
  }
  async function sourceHash(source) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function request(text, job) {
    const messages = [
      { role: 'system', content: C.translationPrompt(job.config.glossary) },
      { role: 'user', content: JSON.stringify({ source: text }) },
    ];
    const config = job.config;
    if (job.controller.signal.aborted) throw C.failure('CANCELLED');
    let result;
    if (config.route === 'profile') {
      const service = ctx().ConnectionManagerRequestService;
      if (!service || !ctx().extensionSettings?.connectionManager?.profiles?.some(p => p.id === config.profileId)) throw C.failure('PROFILE_MISSING');
      result = await service.sendRequest(config.profileId, messages, config.maxTokens, {
        stream: false, extractData: true, includePreset: false, includeInstruct: false,
        signal: job.controller.signal,
      });
      result = result?.content;
    } else {
      const context = ctx(), service = context.ChatCompletionService;
      if (!service?.processRequest) throw C.failure('SERVICE_MISSING');
      let payload = { stream: false, messages, max_tokens: config.maxTokens };
      if (config.route === 'custom') {
        let url;
        try { url = new URL(config.apiurl); } catch { throw C.failure('API_CONFIG'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !config.model.trim()) throw C.failure('API_CONFIG');
        Object.assign(payload, { reverse_proxy: url.href.replace(/\/$/, ''), proxy_password: job.key,
          model: config.model.trim(), chat_completion_source: 'openai' });
      } else {
        if (context.mainApi !== 'openai' || !service.presetToGeneratePayload || !context.getChatCompletionModel) throw C.failure('SERVICE_MISSING');
        payload = await service.presetToGeneratePayload({}, { function_calling: false }, {
          ...payload, model: context.getChatCompletionModel(),
          enable_web_search: false, request_images: false, include_reasoning: false,
        });
        for (const key of ['tools', 'tool_choice', 'json_schema', 'stop', 'logit_bias', 'logprobs', 'user_name', 'char_name', 'group_names']) delete payload[key];
      }
      if (job.controller.signal.aborted) throw C.failure('CANCELLED');
      // The low-level service does not emit host generation lifecycle events.
      result = (await service.processRequest(payload, {}, true, job.controller.signal))?.content;
    }
    if (job.controller.signal.aborted) throw C.failure('CANCELLED');
    return C.parseReply(result);
  }
  async function translate(index, force = false) {
    const context = ctx(), message = context.chat[index];
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return;
    const target = C.snapshot(context, index, epoch);
    let regions;
    try { regions = C.parse(target.source); }
    catch (e) { notify(notices[e.code] || notices.API_FAILED); return; }
    const config = { ...settings };
    const fingerprint = await sourceHash(JSON.stringify([target.source, C.version, config]));
    if (!C.isCurrent(ctx(), target, epoch)) return;
    const cache = message.extra?.[KEY];
    if (!force && cache?.fingerprint === fingerprint && typeof cache.translated === 'string') {
      setDisplay(target, cache.translated); notify('已显示缓存译文。'); return;
    }
    const job = { id: KEY + ':' + crypto.randomUUID(), controller: new AbortController(), config, key: sessionKey };
    active = job;
    try {
      if (!setDisplay(target, C.render(target.source, regions, regions.map(() => '〔正在翻译正文…〕')))) return;
      notify('正在翻译正文；不会占用酒馆发送按钮。');
      const translations = [];
      for (const region of regions) {
        let translated = '';
        for (const chunk of C.split(region.text)) {
          if (!C.isCurrent(ctx(), target, epoch) || job.controller.signal.aborted) return;
          translated += await request(chunk, job);
        }
        translations.push(translated);
      }
      if (!C.isCurrent(ctx(), target, epoch) || job.controller.signal.aborted) return;
      const display = C.render(target.source, regions, translations);
      if (!setDisplay(target, display)) return;
      Object.assign(message.extra[KEY], { fingerprint, translated: display });
      // Save only the current chat after the final synchronous identity check.
      await ctx().saveChat();
      notify('中文已显示；原始正文、变量和数据库内容保持原样。');
    } catch (e) {
      if (job.controller.signal.aborted || !C.isCurrent(ctx(), target, epoch)) return;
      const note = notices[e.code] || notices.API_FAILED;
      if (e.code !== 'DISPLAY_CONFLICT') {
        try { setDisplay(target, C.render(target.source, regions, regions.map(() => `〔${note}〕`))); } catch { /* Foreign display owner wins. */ }
      }
      notify(note); // Never log raw requests, model returns, endpoints or secrets.
    } finally {
      if (active === job) active = null;
    }
  }
  async function drain() {
    if (running || foreground || disposed || !pending) return;
    if (pending.readyAt > Date.now()) {
      clearTimeout(timer); timer = setTimeout(() => void drain(), pending.readyAt - Date.now()); return;
    }
    const work = pending; pending = null; running = true;
    try {
      if (work.epoch === epoch) await translate(work.index, work.force);
    } catch (e) { notify(notices[e.code] || notices.API_FAILED); }
    finally { running = false; if (pending && !foreground) void drain(); }
  }
  function schedule(index, force = false) {
    if (!Number.isInteger(index) || index < 0 || disposed) return;
    pending = { index, force, epoch, readyAt: Date.now() + 650 };
    clearTimeout(timer);
    timer = setTimeout(() => void drain(), 650);
  }
  function lastIndex() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i;
    return -1;
  }
  function invalidateDisplay(index) {
    const message = ctx().chat[index], extra = message?.extra;
    if (extra?.[KEY] && extra.display_text === extra[KEY].display) {
      delete extra.display_text;
      // Preserve cached translation until its fingerprint is checked by translate().
      delete extra[KEY].display;
      ctx().updateMessageBlock(index, message);
    }
  }
  function viewOriginal() {
    abortOwn();
    const index = lastIndex(), target = C.snapshot(ctx(), index, epoch);
    if (!target.message) return;
    try {
      const regions = C.parse(target.source);
      setDisplay(target, C.render(target.source, regions, regions.map(r => C.escapeDisplay(r.text))));
      notify('正在查看最新楼层原文；点“翻译最新”恢复中文。');
    } catch (e) { notify(notices[e.code] || notices.API_FAILED); }
  }
  function restoreAllOriginals() {
    ctx().chat.forEach((m, index) => {
      if (!m.extra?.[KEY]) return;
      try {
        const regions = C.parse(m.mes);
        setDisplay(C.snapshot(ctx(), index, epoch), C.render(m.mes, regions, regions.map(r => C.escapeDisplay(r.text))));
      } catch { /* Leave foreign display owners and malformed messages untouched. */ }
    });
  }
  function openPanel() {
    if (panel?.isConnected) { if (!panel.open) panel.showModal(); return; }
    panel = doc.createElement('dialog'); panel.id = KEY + '_panel';
    panel.style.cssText = 'box-sizing:border-box;width:min(580px,94vw);max-height:88vh;overflow:auto;background:#20242d;color:#f1f3f8;border:1px solid #6b778c;border-radius:14px;padding:20px;font:15px/1.6 sans-serif;';
    panel.setAttribute('aria-label', '双语正文设置');
    panel.innerHTML = `<style>#${KEY}_panel [hidden]{display:none!important} #${KEY}_panel label{display:block} #${KEY}_panel button{min-height:38px}</style><form method="dialog" style="display:grid;gap:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><strong style="font-size:20px">双语正文 · 中文阅读</strong><button value="close" aria-label="关闭设置">✕</button></div>
      <small>试用候选 ${C.version} · 尚未完成真实门禁</small>
      <label><input name="enabled" type="checkbox"> 启用外语正文与自动翻译</label>
      <label>正文语言 <select name="language"><option>日本語</option><option>English</option><option>Français</option><option>한국어</option></select></label>
      <label>翻译连接 <select name="route"><option value="current">酒馆当前连接</option><option value="profile">酒馆已保存的连接配置</option><option value="custom">独立 OpenAI 兼容 API</option></select></label>
      <label data-route="profile">连接配置 <select name="profileId"></select></label>
      <label data-route="custom">API 基础地址 <input name="apiurl" placeholder="https://…/v1" autocomplete="off"></label>
      <label data-route="custom">模型 <input name="model" autocomplete="off"></label>
      <label data-route="custom">API Key（仅本次会话）<input name="key" type="password" autocomplete="new-password"></label>
      <small data-route="custom">密钥不写入脚本、聊天或导出文件；刷新后需重填。长期使用可选酒馆保存的连接配置。</small>
      <label>最大输出 tokens <input name="maxTokens" type="number" min="512" max="65536" step="1"></label>
      <label>术语表（可选）<textarea name="glossary" rows="3" placeholder="原名 = 中文显示名；只影响译文"></textarea></label>
      <small>先导入配套显示正则。只翻译 bt-original 正文，其他结构保持原样；长正文分段请求。其他自动翻译请关闭。</small>
      <div data-status role="status" style="padding:10px;background:#141820;border-radius:8px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" data-save>保存设置</button><button type="button" data-translate>翻译最新</button><button type="button" data-retry>重新翻译</button><button type="button" data-original>查看原文</button><button value="close">关闭</button></div>
    </form>`;
    const form = panel.querySelector('form'), field = name => form.elements.namedItem(name);
    for (const [key, value] of Object.entries(settings)) if (field(key)) {
      if (typeof value === 'boolean') field(key).checked = value; else field(key).value = value;
    }
    let profiles = [];
    try { profiles = ctx().extensionSettings?.connectionManager?.profiles || []; } catch { /* Keep the settings UI reachable during host startup. */ }
    for (const profile of profiles) {
      const option = doc.createElement('option'); option.value = profile.id; option.textContent = profile.name || profile.id;
      field('profileId').append(option);
    }
    field('profileId').value = settings.profileId; field('key').value = sessionKey;
    const updateRoutes = () => panel.querySelectorAll('[data-route]').forEach(el => { el.hidden = el.dataset.route !== field('route').value; });
    field('route').addEventListener('change', updateRoutes); updateRoutes();
    panel.querySelectorAll('input:not([type=checkbox]),select,textarea').forEach(el => { el.style.cssText = 'display:block;width:100%;box-sizing:border-box;padding:7px;background:#10151e;color:#fff;border:1px solid #69758b;border-radius:5px'; });
    panel.querySelectorAll('button').forEach(el => { el.style.cssText = 'padding:7px 11px;cursor:pointer'; });
    panel.querySelector('[data-save]').onclick = async () => {
      if (startupError) { notify(startupError); return; }
      if (foreground) { notify('正文生成中，请结束后保存设置。'); return; }
      if (field('enabled').checked && !hasRegex()) { notify(notices.REGEX_MISSING); return; }
      abortOwn(); removePrompt();
      const next = { ...C.defaults };
      for (const key of Object.keys(next)) next[key] = key === 'enabled' ? field(key).checked : field(key).value;
      next.maxTokens = Math.max(512, Math.min(65536, Number(next.maxTokens) || 8192));
      next.glossary = next.glossary.slice(0, 10000);
      try {
        await updateVariablesWith(vars => { vars[KEY] = { ...next }; return vars; }, { type: 'script' });
        settings = next; sessionKey = field('key').value;
        if (!settings.enabled) restoreAllOriginals();
        notify(settings.enabled ? '已启用：下一轮正文开始使用所选语言。' : '已停用：当前聊天恢复原文阅读。');
      } catch { notify('设置未能保存，请重试。'); }
    };
    const manual = force => {
      if (startupError) { notify(startupError); return; }
      if (foreground) { notify('请等待本轮正文完成。'); return; }
      abortOwn(); schedule(lastIndex(), force);
    };
    panel.querySelector('[data-translate]').onclick = () => manual(false);
    panel.querySelector('[data-retry]').onclick = () => manual(true);
    panel.querySelector('[data-original]').onclick = () => { if (startupError) notify(startupError); else viewOriginal(); };
    panel.addEventListener('close', () => { panel.remove(); panel = null; });
    doc.body.append(panel); notify(status); panel.showModal();
  }
  function mountEntrances() {
    if (disposed || !doc.body) return;
    if (!launcher) {
      launcher = doc.createElement('button');
      launcher.id = KEY + '_launcher'; launcher.type = 'button';
      launcher.textContent = '翻译设置'; launcher.setAttribute('aria-label', '双语正文设置');
      launcher.style.cssText = 'all:initial;box-sizing:border-box;display:block;position:fixed;right:12px;bottom:calc(128px + env(safe-area-inset-bottom,0px));z-index:10000;padding:10px 13px;border:1px solid #7b8bab;border-radius:22px;background:#202a3c;color:#f1f5ff;box-shadow:0 3px 14px #0006;font:14px/1.4 sans-serif;cursor:pointer;';
      launcher.addEventListener('click', openPanel); buttons.push(launcher);
    }
    if (!launcher.isConnected) doc.body.append(launcher);
    const target = doc.querySelector('#extensions_settings2') || doc.querySelector('#extensions_settings');
    if (target) {
      if (!extensionEntry) {
        extensionEntry = doc.createElement('section'); extensionEntry.id = KEY + '_settings_entry';
        extensionEntry.style.cssText = 'box-sizing:border-box;margin:10px 0;padding:12px;border:1px solid #6b778c;border-radius:8px;background:var(--SmartThemeBlurTintColor,#20242d);color:var(--SmartThemeBodyColor,#f1f3f8);';
        extensionEntry.innerHTML = '<strong>双语正文 · 中文阅读</strong><p style="margin:6px 0;font-size:13px">正文语言、翻译接口、术语表与原文切换</p><button type="button" class="menu_button" data-open-settings>打开双语正文设置</button><small data-entry-status style="display:block;margin-top:8px;overflow-wrap:anywhere"></small>';
        extensionEntry.querySelector('[data-open-settings]').addEventListener('click', openPanel);
        buttons.push(extensionEntry);
      }
      if (extensionEntry.parentElement !== target) target.append(extensionEntry);
    }
    notify(status);
  }
  // UI is mounted in the visible parent document, not the Helper's hidden iframe.
  mountEntrances();
  mountObserver = new MutationObserver(() => {
    const target = doc.querySelector('#extensions_settings2') || doc.querySelector('#extensions_settings');
    if (!launcher?.isConnected || (target && extensionEntry?.parentElement !== target)) {
      clearTimeout(mountTimer); mountTimer = setTimeout(mountEntrances, 100);
    }
  });
  mountObserver.observe(doc.documentElement, { childList: true, subtree: true });
  try {
  on(tavern_events.GENERATION_AFTER_COMMANDS, (type, options, dryRun) => {
    if (dryRun || !['normal', 'regenerate', 'continue', 'swipe', 'append', 'appendFinal'].includes(type)) return;
    // Helper generateRaw also emits this event, but with {} even in silent mode.
    if (!foreground || !awaitingPrompt || !options || !Object.hasOwn(options, 'quiet_prompt')) return;
    awaitingPrompt = false;
    removePrompt();
    if (!settings.enabled) return;
    if (!hasRegex()) { notify(notices.REGEX_MISSING); return; }
    injectPrompts([{ id: KEY, position: 'in_chat', depth: 0, role: 'system',
      should_scan: false, content: C.generationPrompt(settings.language) }]);
  });
  on(tavern_events.GENERATION_STARTED, (type, options, dryRun) => {
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    abortOwn(); foreground = true; awaitingPrompt = true; cancelled = false; generationChat = ctx().chat;
    const index = lastIndex();
    if (['continue', 'swipe', 'regenerate', 'append', 'appendFinal'].includes(type)) invalidateDisplay(index);
  });
  on(tavern_events.GENERATION_STOPPED, id => {
    if (typeof id === 'string') return; // An unrelated Helper request was cancelled.
    cancelled = true; foreground = false; awaitingPrompt = false; abortOwn(); removePrompt();
  });
  on(tavern_events.GENERATION_ENDED, () => {
    if (!foreground) return;
    foreground = false; awaitingPrompt = false; removePrompt();
    if (!cancelled && settings.enabled && generationChat === ctx().chat) schedule(lastIndex());
  });
  on(tavern_events.CHAT_CHANGED, () => { abortOwn(); removePrompt(); foreground = false; awaitingPrompt = false; generationChat = null; });
  for (const type of [tavern_events.MESSAGE_EDITED, tavern_events.MESSAGE_SWIPED]) on(type, index => {
    abortOwn(); invalidateDisplay(index);
    if (!foreground && settings.enabled) schedule(index);
  });
  on(tavern_events.MESSAGE_DELETED, () => abortOwn());
  } catch {
    startupError = '酒馆助手事件接口初始化失败；设置页仍可打开，请检查酒馆助手版本后重新启用脚本。';
    listeners.splice(0).forEach(handle => handle?.stop?.()); notify(startupError);
  }
  // Helper's QR button is optional; the visible host entrances work independently.
  const buttonName = '双语正文设置';
  try {
    replaceScriptButtons([{ name: buttonName, visible: true }]);
    on(getButtonEvent(buttonName), openPanel);
  } catch { /* Hidden/unavailable QR buttons must never hide the settings panel. */ }
  const dispose = () => {
    if (disposed) return;
    disposed = true; abortOwn(); removePrompt();
    clearTimeout(mountTimer); clearTimeout(welcomeTimer); mountObserver?.disconnect();
    listeners.forEach(handle => handle?.stop?.()); buttons.forEach(button => button.remove()); panel?.remove();
    delete host[KEY];
  };
  window.addEventListener('pagehide', dispose, { once: true });
  host[KEY] = { dispose, openPanel, version: C.version };
  if (!savedSettings) welcomeTimer = setTimeout(() => { if (!disposed) openPanel(); }, 250);
})();
