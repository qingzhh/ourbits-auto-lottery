// ==UserScript==
// @name         OurBits 自动抽奖
// @namespace    https://github.com/qingzhh/ourbits-auto-lottery
// @version      1.00
// @description  OurBits (lottery.php) 自动抽奖脚本，支持无刷新直连与跨页续航、十连抽/单抽、保底魔力熔断、收益与单GB成本统计、JSON导入导出
// @author       qingzhh
// @match        https://ourbits.club/lottery.php*
// @homepageURL  https://github.com/qingzhh/ourbits-auto-lottery
// @downloadURL  https://raw.githubusercontent.com/qingzhh/ourbits-auto-lottery/main/ourbits-auto-lottery.user.js
// @updateURL    https://raw.githubusercontent.com/qingzhh/ourbits-auto-lottery/main/ourbits-auto-lottery.user.js
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const STORAGE_KEY = 'ob_lottery_stats_v1';
  const CONFIG_KEY = 'ob_lottery_cfg_v1';
  const SESSION_KEY = 'ob_lottery_session_v1';

  const COST_SINGLE = 800;
  const COST_TEN = 8000;

  const PRIZE_META = {
    addUpload:     { label: '增加上传量',   icon: '📈', unit: 'size',  color: '#4ade80' },
    minusUpload:   { label: '减少上传量',   icon: '📉', unit: 'size',  color: '#f87171' },
    addDownload:   { label: '增加下载量',   icon: '⬇️', unit: 'size',  color: '#fb923c' },
    minusDownload: { label: '减少下载量',   icon: '🧹', unit: 'size',  color: '#38bdf8' },
    bonusBack:     { label: '返还魔力',     icon: '💰', unit: 'bonus', color: '#facc15' },
    tempVip:       { label: '临时VIP',      icon: '👑', unit: 'vip',   color: '#e879f9' },
    none:          { label: '什么都没得到', icon: '💨', unit: 'none',  color: '#94a3b8' },
  };

  function createEmptyStats() {
    return {
      rounds: 0,
      totalDraws: 0,
      spentBonus: 0,
      prizes: {
        addUpload:     { count: 0, valueMB: 0 },
        minusUpload:   { count: 0, valueMB: 0 },
        addDownload:   { count: 0, valueMB: 0 },
        minusDownload: { count: 0, valueMB: 0 },
        bonusBack:     { count: 0, value: 0 },
        tempVip:       { count: 0, days: 0, bonusComp: 0 },
        none:          { count: 0 },
      },
      lastPageFingerprint: '',
    };
  }

  function loadJson(key, fallbackFactory) {
    try {
      const raw = GM_getValue(key, null);
      if (!raw) return fallbackFactory();
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Object.assign(fallbackFactory(), parsed);
    } catch {
      return fallbackFactory();
    }
  }

  function loadStats() {
    const base = createEmptyStats();
    const loaded = loadJson(STORAGE_KEY, createEmptyStats);
    loaded.prizes = Object.assign(base.prizes, loaded.prizes || {});
    return loaded;
  }

  function saveStats() {
    GM_setValue(STORAGE_KEY, JSON.stringify(state.stats));
  }

  function loadConfig() {
    return loadJson(CONFIG_KEY, () => ({
      execEngine: 'fetch',
      drawType: 'ten',
      runMode: 'allin',
      targetRounds: 10,
      reserveBonus: 50000,
      intervalMs: 2500,
      jitterMs: 800,
      recordManual: true,
      collapsed: false,
    }));
  }

  function saveConfig() {
    GM_setValue(CONFIG_KEY, JSON.stringify(state.cfg));
  }

  function createEmptySession() {
    return {
      active: false,
      pendingSubmit: false,
      sessionRounds: 0,
      drawType: 'ten',
      updatedAt: 0,
    };
  }

  function loadSession() {
    return loadJson(SESSION_KEY, createEmptySession);
  }

  function saveSession(sess) {
    sess.updatedAt = Date.now();
    GM_setValue(SESSION_KEY, JSON.stringify(sess));
  }

  const state = {
    stats: loadStats(),
    cfg: loadConfig(),
    running: false,
    sessionRounds: 0,
    currentBonus: 0,
    consecutiveErrors: 0,
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function toMB(val, unit) {
    const n = parseFloat(val) || 0;
    const u = String(unit || 'MB').toUpperCase();
    if (u === 'TB') return n * 1024 * 1024;
    if (u === 'GB') return n * 1024;
    if (u === 'KB') return n / 1024;
    return n;
  }

  function formatMB(mb) {
    const sign = mb < 0 ? '-' : '';
    const abs = Math.abs(mb);
    if (abs >= 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(3)} TB`;
    if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(2)} GB`;
    return `${sign}${abs.toFixed(2)} MB`;
  }

  function formatNum(n, digits = 0) {
    return Number(n || 0).toLocaleString('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function readBonusFromDoc(doc = document) {
    const infoEl = doc.querySelector('#info_block') || doc.body;
    const text = (infoEl && infoEl.textContent) || '';
    const m = text.match(/魔力值[\s\S]{0,40}?[:：]\s*([\d,]+(?:\.\d+)?)/);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isNaN(val)) return val;
    }
    return null;
  }

  function findDrawButtons() {
    const all = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a'));
    const tenBtn = all.find((el) => (el.value || el.textContent || el.alt || '').trim().includes('十连抽')) || null;

    let singleBtn = null;
    if (tenBtn) {
      const cell = tenBtn.closest('td');
      if (cell) {
        const candidates = Array.from(cell.querySelectorAll('input[type="image"], input[type="submit"], button, a, img[onclick]'))
          .filter((el) => el !== tenBtn && !el.contains(tenBtn) && !tenBtn.contains(el));
        singleBtn = candidates.find((el) => !((el.value || el.textContent || '').includes('十连抽'))) || null;
        if (singleBtn && singleBtn.tagName === 'IMG' && singleBtn.closest('a, button')) {
          singleBtn = singleBtn.closest('a, button');
        }
      }
    }
    if (!singleBtn) {
      singleBtn = all.find((el) => {
        const txt = (el.value || el.textContent || el.alt || el.title || '').trim();
        return txt.includes('点击抽奖') && !txt.includes('十连抽');
      }) || null;
    }
    return { tenBtn, singleBtn };
  }

  function extractCleanPageText(doc) {
    const clone = doc.body ? doc.body.cloneNode(true) : null;
    if (!clone) return '';
    clone.querySelectorAll('script, style, #ob-lottery-panel').forEach((n) => n.remove());
    return (clone.textContent || '').replace(/\u00a0/g, ' ');
  }

  function parseResultFromDoc(doc) {
    const fullText = extractCleanPageText(doc);
    const parsed = {
      items: [],
      errorMsg: null,
      remainingBonus: readBonusFromDoc(doc),
      rawSlice: '',
    };

    const startMatch = fullText.match(/抽奖结果(?![公示统计])/);
    if (startMatch) {
      const afterStart = fullText.slice(startMatch.index + startMatch[0].length);
      const endMatch = afterStart.match(/抽奖说明|本活动仅对\s*Power\s*User|抽奖结果公示|十连抽（送1次）/);
      const slice = (endMatch ? afterStart.slice(0, endMatch.index) : afterStart.slice(0, 2000)).trim();
      parsed.rawSlice = slice;

      const cleaned = slice.replace(/太惨了[，,\s]*什么都没得到~?/g, '太惨了~');
      const itemRe = /(增加上传量|减少上传量|增加下载量|减少下载量|返还魔力|临时\s*VIP|什么都没得到)(?:\s*\/\s*[A-Za-z0-9\s_-]+)?\s*[：:]\s*([\s\S]*?)(?=(?:增加上传量|减少上传量|增加下载量|减少下载量|返还魔力|临时\s*VIP|什么都没得到)(?:\s*\/\s*[A-Za-z0-9\s_-]+)?\s*[：:]|$)/gi;

      let m;
      while ((m = itemRe.exec(cleaned)) !== null) {
        const label = m[1].replace(/\s+/g, '');
        const valStr = m[2].trim();

        if (label === '增加上传量') {
          const sz = valStr.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
          parsed.items.push({ type: 'addUpload', mb: sz ? toMB(sz[1], sz[2]) : 0 });
        } else if (label === '减少上传量') {
          const sz = valStr.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
          parsed.items.push({ type: 'minusUpload', mb: sz ? toMB(sz[1], sz[2]) : 0 });
        } else if (label === '增加下载量') {
          const sz = valStr.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
          parsed.items.push({ type: 'addDownload', mb: sz ? toMB(sz[1], sz[2]) : 0 });
        } else if (label === '减少下载量') {
          const sz = valStr.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
          parsed.items.push({ type: 'minusDownload', mb: sz ? toMB(sz[1], sz[2]) : 0 });
        } else if (label === '返还魔力') {
          const bm = valStr.match(/([\d,]+(?:\.\d+)?)/);
          parsed.items.push({ type: 'bonusBack', value: bm ? parseFloat(bm[1].replace(/,/g, '')) : 0 });
        } else if (/^临时VIP$/i.test(label)) {
          const dayM = valStr.match(/([\d.]+)\s*(?:天|days?)/i);
          const compM = valStr.match(/([\d,]+(?:\.\d+)?)\s*魔力/);
          parsed.items.push({
            type: 'tempVip',
            days: dayM ? parseFloat(dayM[1]) : 0,
            bonusComp: compM ? parseFloat(compM[1].replace(/,/g, '')) : 0,
          });
        } else if (label === '什么都没得到') {
          parsed.items.push({ type: 'none' });
        }
      }
    }

    if (parsed.items.length === 0) {
      if (/魔力(?:值)?不足|积分不足|余额不足|没有足够的魔力/i.test(fullText)) {
        parsed.errorMsg = '魔力值不足，已停止';
      } else if (/过于频繁|请稍后再试|冷却中|操作太快/i.test(fullText)) {
        parsed.errorMsg = '触发频率限制，已停止';
      } else if (/登录|login\.php/i.test(doc.title || '') || /未登录/.test(fullText)) {
        parsed.errorMsg = '登录态失效，请重新登录';
      }
    }

    return parsed;
  }

  function generateMoodMessage(items) {
    const hasVip = items.some((i) => i.type === 'tempVip');
    const totalUpMB = items.filter((i) => i.type === 'addUpload').reduce((a, b) => a + b.mb, 0);
    const totalDownUpMB = items.filter((i) => i.type === 'minusUpload').reduce((a, b) => a + b.mb, 0);
    const totalBonus = items.filter((i) => i.type === 'bonusBack').reduce((a, b) => a + b.value, 0);
    const noneCount = items.filter((i) => i.type === 'none').length;

    if (hasVip) return { text: '👑 命中【临时VIP】！', mood: 'jackpot' };
    if (totalUpMB >= 4096) return { text: `🔥 本轮 +${formatMB(totalUpMB)} 上传，返还 ${formatNum(totalBonus)} 魔力`, mood: 'great' };
    if (totalUpMB - totalDownUpMB >= 1536 || totalBonus >= 1500) {
      return { text: `✨ 净上传 ${formatMB(totalUpMB - totalDownUpMB)}，返还 ${formatNum(totalBonus)} 魔力`, mood: 'good' };
    }
    if (noneCount >= Math.ceil(items.length * 0.5)) {
      return { text: `💨 本轮 ${noneCount}/${items.length} 次空奖`, mood: 'bad' };
    }
    if (totalDownUpMB > totalUpMB) {
      return { text: `📉 本轮上传净减 ${formatMB(totalDownUpMB - totalUpMB)}`, mood: 'bad' };
    }
    return { text: `🎲 开奖 ${items.length} 项：+${formatMB(totalUpMB)} 上传 / +${formatNum(totalBonus)} 魔力`, mood: 'normal' };
  }

  function applyDrawResult(parsed, drawCost) {
    if (!parsed.items.length) return;
    const s = state.stats;
    s.rounds += 1;
    s.totalDraws += parsed.items.length;
    s.spentBonus += drawCost;

    for (const item of parsed.items) {
      if (item.type === 'addUpload') {
        s.prizes.addUpload.count += 1;
        s.prizes.addUpload.valueMB += item.mb;
      } else if (item.type === 'minusUpload') {
        s.prizes.minusUpload.count += 1;
        s.prizes.minusUpload.valueMB += item.mb;
      } else if (item.type === 'addDownload') {
        s.prizes.addDownload.count += 1;
        s.prizes.addDownload.valueMB += item.mb;
      } else if (item.type === 'minusDownload') {
        s.prizes.minusDownload.count += 1;
        s.prizes.minusDownload.valueMB += item.mb;
      } else if (item.type === 'bonusBack') {
        s.prizes.bonusBack.count += 1;
        s.prizes.bonusBack.value += item.value;
      } else if (item.type === 'tempVip') {
        s.prizes.tempVip.count += 1;
        s.prizes.tempVip.days += item.days;
        s.prizes.tempVip.bonusComp += item.bonusComp;
      } else if (item.type === 'none') {
        s.prizes.none.count += 1;
      }
    }

    if (parsed.remainingBonus != null) {
      state.currentBonus = parsed.remainingBonus;
    } else {
      const back = parsed.items.filter((i) => i.type === 'bonusBack').reduce((a, b) => a + b.value, 0);
      const comp = parsed.items.filter((i) => i.type === 'tempVip').reduce((a, b) => a + (b.bonusComp || 0), 0);
      state.currentBonus = Math.max(0, state.currentBonus - drawCost + back + comp);
    }

    const mood = generateMoodMessage(parsed.items);
    saveStats();
    renderMood(mood.text, mood.mood);
    renderStats();
  }

  async function executeFetchDraw(drawType) {
    const { tenBtn, singleBtn } = findDrawButtons();
    const btn = drawType === 'ten' ? tenBtn : singleBtn;
    if (!btn) return { items: [], errorMsg: '未找到抽奖按钮' };

    const form = btn.closest('form');
    const link = !form ? btn.closest('a[href]') : null;

    let reqUrl = location.href;
    let fetchOpts = { method: 'GET', credentials: 'same-origin' };

    if (form) {
      const method = (form.getAttribute('method') || 'GET').toUpperCase();
      const rawAction = form.getAttribute('action');
      reqUrl = rawAction ? new URL(rawAction, location.href).href : location.href;

      let fd;
      try {
        fd = new FormData(form, btn);
      } catch {
        fd = new FormData(form);
        if (btn.name) fd.append(btn.name, btn.value || '');
      }

      const params = new URLSearchParams();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') params.append(k, v);
      }
      if (btn.tagName === 'INPUT' && btn.type === 'image') {
        const prefix = btn.name ? `${btn.name}.` : '';
        if (!params.has(`${prefix}x`)) {
          params.append(`${prefix}x`, '12');
          params.append(`${prefix}y`, '12');
        }
      }

      if (method === 'POST') {
        fetchOpts = {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: params.toString(),
        };
      } else {
        const u = new URL(reqUrl);
        for (const [k, v] of params.entries()) u.searchParams.append(k, v);
        reqUrl = u.href;
      }
    } else if (link && link.getAttribute('href') && !/^javascript:|#/i.test(link.getAttribute('href'))) {
      reqUrl = new URL(link.getAttribute('href'), location.href).href;
    } else {
      return { items: [], needReloadFallback: true, errorMsg: '请切换为「跨页续航」模式' };
    }

    try {
      const resp = await fetch(reqUrl, fetchOpts);
      const html = await resp.text();
      if (!resp.ok) return { items: [], errorMsg: `HTTP ${resp.status}` };

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const parsed = parseResultFromDoc(doc);
      if (parsed.items.length === 0 && !parsed.errorMsg) {
        return { items: [], needReloadFallback: true, errorMsg: '未捕获到开奖结果，请切换「跨页续航」' };
      }
      return parsed;
    } catch (e) {
      return { items: [], errorMsg: `网络错误: ${e.message}` };
    }
  }

  async function runFetchLoop() {
    const cost = state.cfg.drawType === 'ten' ? COST_TEN : COST_SINGLE;
    state.running = true;
    state.sessionRounds = 0;
    state.consecutiveErrors = 0;
    updateControlState();
    renderMood('🚀 自动抽奖运行中...', 'good');

    while (state.running) {
      if (state.cfg.runMode === 'count' && state.sessionRounds >= state.cfg.targetRounds) {
        renderMood(`✅ 已完成 ${state.cfg.targetRounds} 轮`, 'great');
        break;
      }
      if (state.currentBonus - cost < state.cfg.reserveBonus) {
        renderMood(`🛡️ 触及保底魔力 (${formatNum(state.cfg.reserveBonus)})，已停止`, 'warn');
        break;
      }

      updateStatusBadge(`开奖中 (${state.sessionRounds + 1}${state.cfg.runMode === 'count' ? '/' + state.cfg.targetRounds : '轮'})`);
      const res = await executeFetchDraw(state.cfg.drawType);
      if (!state.running) break;

      if (res.errorMsg) {
        state.consecutiveErrors += 1;
        renderMood(`⚠️ ${res.errorMsg}`, 'bad');
        if (res.needReloadFallback || /魔力值不足|频率限制|未找到|登录态/.test(res.errorMsg) || state.consecutiveErrors >= 3) {
          break;
        }
      } else {
        state.consecutiveErrors = 0;
        state.sessionRounds += 1;
        applyDrawResult(res, cost);
      }

      if (state.cfg.runMode === 'count' && state.sessionRounds >= state.cfg.targetRounds) {
        renderMood(`✅ 已完成 ${state.cfg.targetRounds} 轮`, 'great');
        break;
      }
      if (state.currentBonus - cost < state.cfg.reserveBonus) {
        renderMood(`🛡️ 触及保底魔力 (${formatNum(state.cfg.reserveBonus)})，已停止`, 'warn');
        break;
      }

      const delay = Math.max(1000, Number(state.cfg.intervalMs) || 2500) + Math.floor(Math.random() * (Number(state.cfg.jitterMs) || 500));
      updateStatusBadge(`冷却 ${(delay / 1000).toFixed(1)}s (${state.sessionRounds}${state.cfg.runMode === 'count' ? '/' + state.cfg.targetRounds : '轮'})`);
      await sleep(delay);
    }

    stopAutoLoop(false);
  }

  function installReloadConfirmHook() {
    const origConfirm = pageWin.confirm.bind(pageWin);
    pageWin.confirm = function (msg) {
      const sess = loadSession();
      if (state.running || sess.active) return true;
      return origConfirm(msg);
    };
  }

  function triggerReloadClick(drawType, sessionObj) {
    const { tenBtn, singleBtn } = findDrawButtons();
    const btn = drawType === 'ten' ? tenBtn : singleBtn;
    if (!btn) {
      saveSession(createEmptySession());
      stopAutoLoop(false);
      renderMood('⚠️ 未找到抽奖按钮', 'bad');
      return;
    }
    sessionObj.active = true;
    sessionObj.pendingSubmit = true;
    sessionObj.drawType = drawType;
    saveSession(sessionObj);
    updateStatusBadge('提交中...');
    btn.click();
  }

  async function resumeReloadSessionIfNeeded() {
    const sess = loadSession();
    if (sess.active && Date.now() - (sess.updatedAt || 0) > 120000) {
      saveSession(createEmptySession());
      return;
    }

    const parsed = parseResultFromDoc(document);
    const liveBonus = readBonusFromDoc(document);
    if (liveBonus != null) state.currentBonus = liveBonus;

    if (parsed.items.length > 0) {
      const fp = `${state.currentBonus}|${parsed.rawSlice}`;
      if (fp !== state.stats.lastPageFingerprint) {
        state.stats.lastPageFingerprint = fp;
        if (sess.active && sess.pendingSubmit) {
          const cost = sess.drawType === 'ten' ? COST_TEN : COST_SINGLE;
          sess.sessionRounds += 1;
          applyDrawResult(parsed, cost);
        } else if (state.cfg.recordManual) {
          const inferredCost = parsed.items.length >= 10 ? COST_TEN : COST_SINGLE;
          applyDrawResult(parsed, inferredCost);
        } else {
          saveStats();
        }
      }
    }

    if (!sess.active) return;

    sess.pendingSubmit = false;
    saveSession(sess);

    const cost = state.cfg.drawType === 'ten' ? COST_TEN : COST_SINGLE;
    state.sessionRounds = sess.sessionRounds;

    if (parsed.errorMsg) {
      saveSession(createEmptySession());
      renderMood(`⚠️ ${parsed.errorMsg}`, 'bad');
      return;
    }
    if (state.cfg.runMode === 'count' && sess.sessionRounds >= state.cfg.targetRounds) {
      saveSession(createEmptySession());
      renderMood(`✅ 已完成 ${state.cfg.targetRounds} 轮`, 'great');
      return;
    }
    if (state.currentBonus - cost < state.cfg.reserveBonus) {
      saveSession(createEmptySession());
      renderMood(`🛡️ 触及保底魔力 (${formatNum(state.cfg.reserveBonus)})，已停止`, 'warn');
      return;
    }

    state.running = true;
    updateControlState();
    const delay = Math.max(1000, Number(state.cfg.intervalMs) || 2500) + Math.floor(Math.random() * (Number(state.cfg.jitterMs) || 500));
    updateStatusBadge(`冷却 ${(delay / 1000).toFixed(1)}s (${sess.sessionRounds}${state.cfg.runMode === 'count' ? '/' + state.cfg.targetRounds : '轮'})`);
    await sleep(delay);

    if (!state.running) return;
    triggerReloadClick(state.cfg.drawType, sess);
  }

  function startAutoLoop() {
    if (state.running) return;
    const liveBonus = readBonusFromDoc(document);
    if (liveBonus != null) state.currentBonus = liveBonus;

    const cost = state.cfg.drawType === 'ten' ? COST_TEN : COST_SINGLE;
    if (state.currentBonus < state.cfg.reserveBonus + cost) {
      renderMood(`🛑 剩余魔力不足保底线 (${formatNum(state.cfg.reserveBonus)})`, 'warn');
      return;
    }

    if (state.cfg.execEngine === 'reload') {
      state.running = true;
      state.sessionRounds = 0;
      updateControlState();
      triggerReloadClick(state.cfg.drawType, createEmptySession());
    } else {
      saveSession(createEmptySession());
      runFetchLoop();
    }
  }

  function stopAutoLoop(manual = true) {
    state.running = false;
    saveSession(createEmptySession());
    updateControlState();
    if (manual) renderMood(`⏹️ 已停止（本次 ${state.sessionRounds} 轮）`, 'normal');
  }

  GM_addStyle(`
    #ob-lottery-panel {
      position: fixed !important;
      top: 72px;
      right: 20px;
      width: 386px !important;
      max-height: 88vh;
      overflow-y: auto;
      z-index: 999999 !important;
      background: linear-gradient(160deg, #1d1216 0%, #120d10 100%) !important;
      color: #f8fafc !important;
      border: 1px solid rgba(212, 175, 55, 0.5) !important;
      border-radius: 14px !important;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 215, 120, 0.15) !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
      font-size: 12px !important;
      line-height: 1.45 !important;
      text-align: left !important;
    }
    #ob-lottery-panel * { box-sizing: border-box !important; }
    #ob-lottery-panel.collapsed { width: auto !important; overflow: hidden !important; }
    #ob-lottery-panel.collapsed .ob-body { display: none !important; }
    #ob-lottery-panel .ob-hidden { display: none !important; }
    #ob-lottery-panel .ob-header {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 10px 14px !important;
      background: linear-gradient(90deg, #7f1d1d 0%, #991b1b 55%, #78350f 100%) !important;
      border-bottom: 1px solid rgba(212, 175, 55, 0.4) !important;
      cursor: move !important;
      user-select: none !important;
    }
    #ob-lottery-panel .ob-title {
      font-weight: 700 !important;
      font-size: 13px !important;
      color: #fef08a !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
    }
    #ob-lottery-panel .ob-badge {
      font-size: 11px !important;
      padding: 2px 7px !important;
      border-radius: 999px !important;
      background: rgba(0,0,0,0.38) !important;
      color: #fde68a !important;
      border: 1px solid rgba(253, 230, 138, 0.3) !important;
    }
    #ob-lottery-panel .ob-toggle-btn {
      background: rgba(255,255,255,0.14) !important;
      border: none !important;
      color: #fff !important;
      border-radius: 6px !important;
      padding: 3px 9px !important;
      cursor: pointer !important;
      font-size: 12px !important;
    }
    #ob-lottery-panel .ob-toggle-btn:hover { background: rgba(255,255,255,0.24) !important; }
    #ob-lottery-panel .ob-body {
      padding: 12px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 10px !important;
    }
    #ob-lottery-panel .ob-kpi-grid {
      display: grid !important;
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 8px !important;
    }
    #ob-lottery-panel .ob-kpi-card {
      background: rgba(255, 255, 255, 0.05) !important;
      border: 1px solid rgba(255, 255, 255, 0.09) !important;
      border-radius: 8px !important;
      padding: 7px 10px !important;
    }
    #ob-lottery-panel .ob-kpi-label { color: #94a3b8 !important; font-size: 11px !important; }
    #ob-lottery-panel .ob-kpi-val { color: #fef08a !important; font-size: 14px !important; font-weight: 700 !important; margin-top: 2px !important; }
    #ob-lottery-panel .ob-kpi-sub { color: #94a3b8 !important; font-size: 10.5px !important; margin-top: 2px !important; }
    #ob-lottery-panel .ob-mood {
      padding: 8px 10px !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, 0.06) !important;
      border-left: 3px solid #eab308 !important;
      color: #f1f5f9 !important;
      font-size: 12px !important;
    }
    #ob-lottery-panel .ob-mood.jackpot { background: rgba(168, 85, 247, 0.22) !important; border-left-color: #e879f9 !important; color: #f5d0fe !important; font-weight: 600 !important; }
    #ob-lottery-panel .ob-mood.great   { background: rgba(34, 197, 94, 0.16) !important; border-left-color: #4ade80 !important; color: #bbf7d0 !important; }
    #ob-lottery-panel .ob-mood.good    { background: rgba(234, 179, 8, 0.14) !important; border-left-color: #facc15 !important; }
    #ob-lottery-panel .ob-mood.bad     { background: rgba(239, 68, 68, 0.16) !important; border-left-color: #f87171 !important; color: #fecaca !important; }
    #ob-lottery-panel .ob-mood.warn    { background: rgba(249, 115, 22, 0.18) !important; border-left-color: #fb923c !important; color: #fed7aa !important; }
    #ob-lottery-panel .ob-controls {
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.09) !important;
      border-radius: 8px !important;
      padding: 9px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 7px !important;
    }
    #ob-lottery-panel .ob-row {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 8px !important;
    }
    #ob-lottery-panel .ob-row label { color: #cbd5e1 !important; white-space: nowrap !important; }
    #ob-lottery-panel .ob-input, #ob-lottery-panel .ob-select {
      background: #0f172a !important;
      color: #f8fafc !important;
      border: 1px solid #334155 !important;
      border-radius: 6px !important;
      padding: 4px 7px !important;
      font-size: 12px !important;
      outline: none !important;
    }
    #ob-lottery-panel .ob-input:focus, #ob-lottery-panel .ob-select:focus { border-color: #eab308 !important; }
    #ob-lottery-panel .ob-input[type="number"] { width: 92px !important; text-align: right !important; }
    #ob-lottery-panel .ob-action-btn {
      width: 100% !important;
      padding: 8px !important;
      border: none !important;
      border-radius: 8px !important;
      font-weight: 700 !important;
      font-size: 13px !important;
      cursor: pointer !important;
    }
    #ob-lottery-panel .ob-btn-start {
      background: linear-gradient(90deg, #dc2626 0%, #d97706 100%) !important;
      color: #fff !important;
      box-shadow: 0 4px 12px rgba(220, 38, 38, 0.35) !important;
    }
    #ob-lottery-panel .ob-btn-stop {
      background: linear-gradient(90deg, #475569 0%, #334155 100%) !important;
      color: #fecaca !important;
      border: 1px solid #f87171 !important;
    }
    #ob-lottery-panel table.ob-table,
    #ob-lottery-panel table.ob-table thead,
    #ob-lottery-panel table.ob-table tbody,
    #ob-lottery-panel table.ob-table tr,
    #ob-lottery-panel table.ob-table th,
    #ob-lottery-panel table.ob-table td {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      border-left: none !important;
      border-right: none !important;
      border-top: none !important;
      box-shadow: none !important;
      font-size: 11.5px !important;
    }
    #ob-lottery-panel table.ob-table { width: 100% !important; border-collapse: collapse !important; }
    #ob-lottery-panel table.ob-table th,
    #ob-lottery-panel table.ob-table td {
      padding: 5px 6px !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      text-align: left !important;
    }
    #ob-lottery-panel table.ob-table th { color: #94a3b8 !important; font-weight: 600 !important; }
    #ob-lottery-panel table.ob-table td { color: #e2e8f0 !important; }
    #ob-lottery-panel table.ob-table td.num,
    #ob-lottery-panel table.ob-table th.num { text-align: right !important; font-variant-numeric: tabular-nums !important; }
    #ob-lottery-panel .ob-footer { display: flex !important; gap: 6px !important; }
    #ob-lottery-panel .ob-mini-btn {
      flex: 1 !important;
      background: rgba(255, 255, 255, 0.07) !important;
      color: #cbd5e1 !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 6px !important;
      padding: 5px 6px !important;
      font-size: 11px !important;
      cursor: pointer !important;
    }
    #ob-lottery-panel .ob-mini-btn:hover { background: rgba(255, 255, 255, 0.15) !important; color: #fff !important; }
  `);

  function buildUI() {
    const panel = document.createElement('div');
    panel.id = 'ob-lottery-panel';
    if (state.cfg.collapsed) panel.classList.add('collapsed');

    panel.innerHTML = `
      <div class="ob-header" id="ob-drag-handle">
        <div class="ob-title">
          <span>🎰 OurBits 自动抽奖 v1.00</span>
          <span class="ob-badge" id="ob-status-badge">待机</span>
        </div>
        <button class="ob-toggle-btn" id="ob-collapse-btn">${state.cfg.collapsed ? '展开' : '收起'}</button>
      </div>
      <div class="ob-body">
        <div class="ob-kpi-grid">
          <div class="ob-kpi-card">
            <div class="ob-kpi-label">当前魔力值</div>
            <div class="ob-kpi-val" id="ob-kpi-bonus">--</div>
            <div class="ob-kpi-sub" id="ob-kpi-spent">总投 0 | 净耗 0</div>
          </div>
          <div class="ob-kpi-card">
            <div class="ob-kpi-label">净上传收益</div>
            <div class="ob-kpi-val" id="ob-kpi-netup">0.00 MB</div>
            <div class="ob-kpi-sub" id="ob-kpi-costgb">单GB净成本: --</div>
          </div>
        </div>

        <div class="ob-mood" id="ob-mood-bar">✨ 就绪</div>

        <div class="ob-controls">
          <div class="ob-row">
            <label>执行引擎</label>
            <select class="ob-select" id="ob-exec-engine">
              <option value="fetch">无刷新直连</option>
              <option value="reload">跨页续航</option>
            </select>
          </div>
          <div class="ob-row">
            <label>抽奖方式</label>
            <select class="ob-select" id="ob-draw-type">
              <option value="ten">十连抽 (8,000)</option>
              <option value="single">单抽 (800)</option>
            </select>
          </div>
          <div class="ob-row">
            <label>运行策略</label>
            <select class="ob-select" id="ob-run-mode">
              <option value="allin">一抽到底</option>
              <option value="count">指定轮数</option>
            </select>
          </div>
          <div class="ob-row" id="ob-rounds-row">
            <label>目标轮数</label>
            <input class="ob-input" type="number" id="ob-target-rounds" min="1" max="9999" />
          </div>
          <div class="ob-row">
            <label>保底魔力</label>
            <input class="ob-input" type="number" id="ob-reserve-bonus" min="0" step="1000" />
          </div>
          <div class="ob-row">
            <label>间隔 / 抖动 (ms)</label>
            <div style="display:flex;gap:4px;">
              <input class="ob-input" style="width:68px !important" type="number" id="ob-interval-ms" min="1000" step="200" />
              <input class="ob-input" style="width:54px !important" type="number" id="ob-jitter-ms" min="0" step="100" />
            </div>
          </div>
          <button class="ob-action-btn ob-btn-start" id="ob-main-btn">开始自动抽奖</button>
        </div>

        <table class="ob-table">
          <thead>
            <tr>
              <th>奖项 (共 <span id="ob-total-draws">0</span> 次)</th>
              <th class="num">次数</th>
              <th class="num">占比</th>
              <th class="num">累计奖值</th>
            </tr>
          </thead>
          <tbody id="ob-stats-tbody"></tbody>
        </table>

        <div class="ob-footer">
          <button class="ob-mini-btn" id="ob-btn-export">导出JSON</button>
          <button class="ob-mini-btn" id="ob-btn-import">导入JSON</button>
          <button class="ob-mini-btn" id="ob-btn-reset">清空统计</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindUIEvents(panel);
    makeDraggable(panel, panel.querySelector('#ob-drag-handle'));
  }

  function bindUIEvents(panel) {
    const elEngine = panel.querySelector('#ob-exec-engine');
    const elType = panel.querySelector('#ob-draw-type');
    const elMode = panel.querySelector('#ob-run-mode');
    const elRoundsRow = panel.querySelector('#ob-rounds-row');
    const elRounds = panel.querySelector('#ob-target-rounds');
    const elReserve = panel.querySelector('#ob-reserve-bonus');
    const elInterval = panel.querySelector('#ob-interval-ms');
    const elJitter = panel.querySelector('#ob-jitter-ms');
    const elMainBtn = panel.querySelector('#ob-main-btn');
    const elCollapse = panel.querySelector('#ob-collapse-btn');

    elEngine.value = state.cfg.execEngine;
    elType.value = state.cfg.drawType;
    elMode.value = state.cfg.runMode;
    elRounds.value = state.cfg.targetRounds;
    elReserve.value = state.cfg.reserveBonus;
    elInterval.value = state.cfg.intervalMs;
    elJitter.value = state.cfg.jitterMs;
    elRoundsRow.classList.toggle('ob-hidden', state.cfg.runMode !== 'count');

    const syncCfg = () => {
      state.cfg.execEngine = elEngine.value;
      state.cfg.drawType = elType.value;
      state.cfg.runMode = elMode.value;
      state.cfg.targetRounds = Math.max(1, parseInt(elRounds.value, 10) || 1);
      state.cfg.reserveBonus = Math.max(0, parseInt(elReserve.value, 10) || 0);
      state.cfg.intervalMs = Math.max(1000, parseInt(elInterval.value, 10) || 2500);
      state.cfg.jitterMs = Math.max(0, parseInt(elJitter.value, 10) || 500);
      elRoundsRow.classList.toggle('ob-hidden', state.cfg.runMode !== 'count');
      saveConfig();
    };

    [elEngine, elType, elMode, elRounds, elReserve, elInterval, elJitter].forEach((el) => {
      el.addEventListener('change', syncCfg);
    });

    elMainBtn.addEventListener('click', () => {
      syncCfg();
      if (state.running) stopAutoLoop(true);
      else startAutoLoop();
    });

    elCollapse.addEventListener('click', () => {
      state.cfg.collapsed = !state.cfg.collapsed;
      panel.classList.toggle('collapsed', state.cfg.collapsed);
      elCollapse.textContent = state.cfg.collapsed ? '展开' : '收起';
      saveConfig();
    });

    panel.querySelector('#ob-btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.stats, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ourbits_lottery_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    });

    panel.querySelector('#ob-btn-import').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const imported = JSON.parse(String(reader.result));
            state.stats = Object.assign(createEmptyStats(), imported);
            saveStats();
            renderStats();
            renderMood('📥 导入成功', 'good');
          } catch {
            renderMood('❌ JSON 格式错误', 'bad');
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });

    panel.querySelector('#ob-btn-reset').addEventListener('click', () => {
      if (!pageWin.confirm('确定清空本地统计数据？')) return;
      state.stats = createEmptyStats();
      saveStats();
      renderStats();
      renderMood('🧹 已清空', 'normal');
    });
  }

  function makeDraggable(el, handle) {
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      el.style.right = 'auto';
      el.style.left = `${origLeft}px`;
      el.style.top = `${origTop}px`;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = `${Math.max(0, origLeft + e.clientX - startX)}px`;
      el.style.top = `${Math.max(0, origTop + e.clientY - startY)}px`;
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function updateStatusBadge(text) {
    const el = document.querySelector('#ob-status-badge');
    if (el) el.textContent = text;
  }

  function updateControlState() {
    const btn = document.querySelector('#ob-main-btn');
    if (!btn) return;
    if (state.running) {
      btn.textContent = '停止自动抽奖';
      btn.className = 'ob-action-btn ob-btn-stop';
      updateStatusBadge('运行中');
    } else {
      btn.textContent = '开始自动抽奖';
      btn.className = 'ob-action-btn ob-btn-start';
      updateStatusBadge('待机');
    }
  }

  function renderMood(text, mood = 'normal') {
    const el = document.querySelector('#ob-mood-bar');
    if (!el) return;
    el.textContent = text;
    el.className = `ob-mood ${mood}`;
  }

  function renderStats() {
    const s = state.stats;
    const p = s.prizes;
    const netUpMB = p.addUpload.valueMB - p.minusUpload.valueMB;
    const netBonusSpent = s.spentBonus - p.bonusBack.value - (p.tempVip.bonusComp || 0);
    const costPerGB = netUpMB > 0 ? netBonusSpent / (netUpMB / 1024) : null;

    const elBonus = document.querySelector('#ob-kpi-bonus');
    const elSpent = document.querySelector('#ob-kpi-spent');
    const elNetUp = document.querySelector('#ob-kpi-netup');
    const elCostGB = document.querySelector('#ob-kpi-costgb');
    const elTotal = document.querySelector('#ob-total-draws');
    const tbody = document.querySelector('#ob-stats-tbody');

    if (elBonus) elBonus.textContent = formatNum(state.currentBonus, 1);
    if (elSpent) elSpent.textContent = `总投 ${formatNum(s.spentBonus)} | 净耗 ${formatNum(netBonusSpent)}`;
    if (elNetUp) {
      elNetUp.textContent = formatMB(netUpMB);
      elNetUp.style.setProperty('color', netUpMB >= 0 ? '#4ade80' : '#f87171', 'important');
    }
    if (elCostGB) {
      elCostGB.textContent = costPerGB !== null ? `单GB净成本: ${formatNum(costPerGB, 0)} 魔力` : '单GB净成本: --';
    }
    if (elTotal) elTotal.textContent = formatNum(s.totalDraws);

    if (tbody) {
      const total = s.totalDraws || 1;
      tbody.innerHTML = Object.keys(PRIZE_META).map((key) => {
        const meta = PRIZE_META[key];
        const stat = p[key];
        const pct = s.totalDraws ? `${((stat.count / total) * 100).toFixed(1)}%` : '0.0%';
        let valText = '-';
        if (meta.unit === 'size') valText = formatMB(stat.valueMB);
        else if (meta.unit === 'bonus') valText = `${formatNum(stat.value)} 魔力`;
        else if (meta.unit === 'vip') {
          valText = stat.days ? `${stat.days} 天` : (stat.bonusComp ? `${formatNum(stat.bonusComp)} 魔力` : '-');
        }
        return `
          <tr>
            <td style="color:${meta.color} !important">${meta.icon} ${meta.label}</td>
            <td class="num">${stat.count}</td>
            <td class="num">${pct}</td>
            <td class="num">${valText}</td>
          </tr>
        `;
      }).join('');
    }
  }

  installReloadConfirmHook();
  const initBonus = readBonusFromDoc(document);
  if (initBonus != null) state.currentBonus = initBonus;
  buildUI();
  renderStats();
  resumeReloadSessionIfNeeded();
})();

