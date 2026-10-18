// ==UserScript==
// @name         青岛干部网络学院 - 自动课程学习助手
// @namespace    https://www.qdgbjy.gov.cn/
// @version      3.0.4
// @description  显示脚本运行状态，自动播放、切换小节和课程，并与可选桌面端同步状态。
// @author       Antigravity
// @match        https://qdgbjy.gov.cn/*
// @match        http://qdgbjy.gov.cn/*
// @match        https://www.qdgbjy.gov.cn/*
// @match        http://www.qdgbjy.gov.cn/*
// @match        https://*.qdgbjy.gov.cn/*
// @match        http://*.qdgbjy.gov.cn/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '3.0.4';
  const PERSON_URL = 'https://www.qdgbjy.gov.cn/person';
  const STORAGE_KEY_AUTO = 'qdgbjy_auto_study_enabled_v3';
  const STORAGE_KEY_COURSE_LOCK = 'qdgbjy_course_tab_lock_v304';
  const COURSE_LAUNCH_TIMEOUT = 120000;
  const COURSE_ACTIVE_TIMEOUT = 6 * 60 * 60 * 1000;
  const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const BRIDGE_URLS = ['http://127.0.0.1:7791', 'http://127.0.0.1:17791'];
  const IS_TOP = window.self === window.top;
  const state = {
    mode: 'unknown',
    message: '脚本已载入，正在识别页面…',
    courseTitle: '',
    progress: '',
    courses: [],
    bridgeConnected: false,
    preferredBridge: '',
    lastCommandRevision: null,
    lastRefreshRevision: null,
    actionLockedUntil: 0,
    closingCourse: false,
    personReloading: false,
    lastUrl: location.href,
  };

  function readCourseLock() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_COURSE_LOCK);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || typeof value.status !== 'string' || typeof value.at !== 'number') return null;
      return value;
    } catch (_error) {
      return null;
    }
  }

  function writeCourseLock(status, title = '') {
    try {
      localStorage.setItem(
        STORAGE_KEY_COURSE_LOCK,
        JSON.stringify({ status, title: String(title || '').slice(0, 300), at: Date.now(), owner: TAB_ID })
      );
    } catch (_error) {}
  }

  function clearCourseLock(owner = '') {
    try {
      if (owner) {
        const lock = readCourseLock();
        if (lock?.owner && lock.owner !== owner) return;
      }
      localStorage.removeItem(STORAGE_KEY_COURSE_LOCK);
    } catch (_error) {}
  }

  function releaseOwnedCourseLock() {
    if (state.mode !== 'detail') return;
    const lock = readCourseLock();
    if (lock?.status === 'active' && lock.owner === TAB_ID) {
      writeCourseLock('closed', lock.title || state.courseTitle);
    }
  }

  function activeCourseLock() {
    const lock = readCourseLock();
    if (!lock) return null;
    const age = Date.now() - lock.at;
    const timeout = lock.status === 'launching' ? COURSE_LAUNCH_TIMEOUT : COURSE_ACTIVE_TIMEOUT;
    if (lock.status === 'completed' || lock.status === 'closed') return lock;
    if ((lock.status === 'launching' || lock.status === 'active') && age < timeout) return lock;
    clearCourseLock();
    return null;
  }

  function getAutoEnabled() {
    try {
      const value = GM_getValue(STORAGE_KEY_AUTO, true);
      return value === true || value === 'true';
    } catch (_error) {
      try {
        const value = localStorage.getItem(STORAGE_KEY_AUTO);
        return value === null ? true : value === 'true';
      } catch (_ignored) {
        return true;
      }
    }
  }

  function setAutoEnabled(enabled) {
    const value = Boolean(enabled);
    try {
      GM_setValue(STORAGE_KEY_AUTO, value);
    } catch (_error) {
      try {
        localStorage.setItem(STORAGE_KEY_AUTO, value ? 'true' : 'false');
      } catch (_ignored) {}
    }
    if (!value) {
      state.message = '自动学习已暂停；脚本仍在正常运行。';
    }
    updateFloatingUI();
  }

  function textOf(element) {
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function parseProgress(text) {
    const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*%/);
    return match ? `${match[1]}%` : '';
  }

  function progressNumber(text) {
    const value = Number.parseFloat(String(text || '').replace('%', ''));
    return Number.isFinite(value) ? value : 0;
  }

  function lockAction(milliseconds = 2500) {
    state.actionLockedUntil = Date.now() + milliseconds;
  }

  function canAct() {
    return Date.now() >= state.actionLockedUntil;
  }

  function hasActiveClass(element) {
    return /(?:^|[_\s-])(on|active|current)(?:$|[_\s-])/i.test(String(element?.className || ''));
  }

  function safeClick(element, lockMilliseconds = 2500) {
    if (!isVisible(element) || !canAct()) return false;
    lockAction(lockMilliseconds);
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    element.click();
    return true;
  }

  function findByText(selector, keywords, partial = false) {
    const wanted = keywords.map((item) => item.trim());
    return Array.from(document.querySelectorAll(selector)).find((element) => {
      if (!isVisible(element)) return false;
      const text = textOf(element);
      return partial ? wanted.some((word) => text.includes(word)) : wanted.includes(text);
    });
  }

  function getSections() {
    return Array.from(document.querySelectorAll('.t1-cell')).map((cell, index) => {
      const title = textOf(cell.querySelector('.t1-cell-title')) || `第 ${index + 1} 节`;
      const progress = parseProgress(textOf(cell.querySelector('.t1-cell-progress'))) || '0%';
      const className = String(cell.className || '');
      const current = Boolean(
        cell.querySelector('.t1-cell-text-c, .active, .on') ||
        /(^|\s)(active|on|current)(\s|$)/i.test(className)
      );
      return { cell, title, progress, current };
    });
  }

  function courseElements() {
    const primary = Array.from(document.querySelectorAll('.user_my_main_body_ul_li_1'));
    if (primary.length) return primary;

    const candidates = Array.from(
      document.querySelectorAll('[class*="course"], [class*="Course"], li[class*="learn"]')
    );
    return candidates.filter((element) => {
      const text = textOf(element);
      return /\d+(?:\.\d+)?\s*%/.test(text) && text.length < 1000;
    });
  }

  function courseTitleElement(item) {
    return (
      item.querySelector('.user_my_main_body_ul_li_1_title') ||
      item.querySelector('[class*="course-title"], [class*="course_name"], [class*="title"]') ||
      item.querySelector('a[href*="detail"], a[href*="course"]') ||
      item
    );
  }

  function collectCourses() {
    return courseElements().map((item, index) => {
      const titleElement = courseTitleElement(item);
      const title = textOf(titleElement) || `未命名课程 ${index + 1}`;
      const progressElement = item.querySelector('.progress_num, [class*="progress"]');
      const progress = parseProgress(textOf(progressElement)) || parseProgress(textOf(item)) || '0%';
      return {
        item,
        titleElement,
        title,
        progress,
        status: progressNumber(progress) >= 100 ? '已完成' : '学习中',
      };
    });
  }

  function totalProgress(sections = []) {
    const bodyText = textOf(document.body);
    const labeled = bodyText.match(/学习进度\s*[：:]?\s*(\d+(?:\.\d+)?)\s*%/);
    if (labeled) return `${labeled[1]}%`;
    const progressElement = document.querySelector(
      '.progress_num, [class*="total-progress"], [class*="study-progress"]'
    );
    const direct = parseProgress(textOf(progressElement));
    if (direct) return direct;
    if (sections.length) {
      const average = sections.reduce((sum, section) => sum + progressNumber(section.progress), 0) / sections.length;
      return `${Math.round(average)}%`;
    }
    return '';
  }

  function currentCourseTitle() {
    const selectors = [
      '.vedio-name',
      '.video-name',
      '.course-title',
      '.user_my_main_body_ul_li_1_title',
      'h1',
      'h2',
    ];
    for (const selector of selectors) {
      const value = textOf(document.querySelector(selector));
      if (value && value.length <= 300) return value;
    }
    return document.title || '';
  }

  function detectMode() {
    const path = `${location.pathname}${location.hash}`;
    if (/login|Login|webAuth/i.test(path)) return 'login';
    if (/detail/i.test(path)) return 'detail';
    if (/person/i.test(path)) return 'person';
    if (document.querySelector('.t1-cell, .xgplayer, #vedio-area video')) return 'detail';
    if (document.querySelector('.user_my_nav_li, .user_my_main_body_ul_li_1')) return 'person';
    return 'other';
  }

  function getUserName() {
    for (const key of ['userInfo', 'user_info', 'user']) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const value = JSON.parse(raw);
        const name = value?.name || value?.realName || value?.userName || value?.xm;
        if (name) return String(name).slice(0, 100);
      } catch (_ignored) {}
    }
    const element = document.querySelector(
      '.user-name, .username, [class*="user_name"], [class*="real-name"]'
    );
    const name = textOf(element);
    return name.length <= 100 ? name : '';
  }

  function ensureFloatingUI() {
    if (!IS_TOP) return null;
    let host = document.getElementById('qdgbjy-helper-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'qdgbjy-helper-host';
      host.style.cssText = [
        'all: initial !important',
        'position: fixed !important',
        'right: 24px !important',
        'bottom: 24px !important',
        'z-index: 2147483647 !important',
        'display: block !important',
      ].join(';');
      (document.body || document.documentElement).appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          * { box-sizing: border-box; }
          .box { width: 330px; padding: 14px 16px; color: #1f2937; background: #fff;
            border: 2px solid #2563eb; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.25);
            font: 13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
          .head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:9px; }
          .title { color:#1e40af; font-weight:700; font-size:14px; }
          .tag { flex:none; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:700; }
          .running { color:#15803d; background:#dcfce7; }
          .paused { color:#b91c1c; background:#fee2e2; }
          .info { min-height:48px; padding:7px 9px; white-space:pre-line; color:#4b5563;
            background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; }
          .bridge { margin:7px 1px; color:#64748b; font-size:11px; }
          button { width:100%; padding:8px 0; border:0; border-radius:6px; color:#fff; font-weight:700;
            font-size:13px; cursor:pointer; background:#2563eb; }
          button.stop { background:#ef4444; }
        </style>
        <div class="box">
          <div class="head">
            <span class="title">● 青岛网院助手 v${VERSION}</span>
            <span id="status" class="tag running">脚本已启动</span>
          </div>
          <div id="info" class="info">脚本已载入，正在识别页面…</div>
          <div id="bridge" class="bridge">桌面端未连接（不影响脚本独立运行）</div>
          <button id="toggle" type="button">暂停自动学习</button>
        </div>`;
      shadow.getElementById('toggle').addEventListener('click', () => {
        setAutoEnabled(!getAutoEnabled());
      });
    }
    return host.shadowRoot;
  }

  function updateFloatingUI() {
    const root = ensureFloatingUI();
    if (!root) return;
    const enabled = getAutoEnabled();
    const tag = root.getElementById('status');
    const info = root.getElementById('info');
    const bridge = root.getElementById('bridge');
    const toggle = root.getElementById('toggle');
    tag.textContent = enabled ? '自动运行中' : '已暂停';
    tag.className = `tag ${enabled ? 'running' : 'paused'}`;
    info.textContent = state.message || '脚本运行正常。';
    bridge.textContent = state.bridgeConnected
      ? '桌面端已连接，状态与按钮可同步'
      : '桌面端未连接（不影响脚本独立运行）';
    toggle.textContent = enabled ? '⏹ 暂停自动学习' : '▶ 启动自动学习';
    toggle.className = enabled ? 'stop' : '';
  }

  function autoPlayTick() {
    if (!getAutoEnabled()) return;

    const videos = Array.from(document.querySelectorAll('video'));
    const pausedVideo = videos.find((video) => video.paused && !video.ended);
    if (pausedVideo) {
      pausedVideo.muted = true;
      pausedVideo.play().catch(() => {});
      const bigPlay = document.querySelector(
        '.xgplayer-start, .vjs-big-play-button, [class*="play-btn"], [class*="start-btn"]'
      );
      if (isVisible(bigPlay)) bigPlay.click();
    }

    const dialog = document.querySelector(
      '[role="dialog"], .el-dialog, .ant-modal, .layui-layer, .modal, [class*="dialog"]'
    );
    if (dialog && isVisible(dialog)) {
      const dialogButton = Array.from(dialog.querySelectorAll('button, [role="button"], a')).find((element) =>
        ['开始学习', '继续学习', '从头开始', '知道了', '立即学习', '确定'].includes(textOf(element))
      );
      if (dialogButton && isVisible(dialogButton)) dialogButton.click();
    } else {
      const startButton = findByText(
        'button, [role="button"], a',
        ['开始学习', '继续学习', '从头开始', '立即学习'],
        false
      );
      if (startButton && isVisible(startButton)) startButton.click();
    }
  }

  function returnToPersonPage() {
    if (window.opener && !window.opener.closed) {
      window.close();
      setTimeout(() => {
        if (!window.closed) location.assign(PERSON_URL);
      }, 1200);
      return;
    }
    location.assign(PERSON_URL);
  }

  function handleDetailPage() {
    const sections = getSections();
    const progress = totalProgress(sections);
    const title = currentCourseTitle();
    state.courseTitle = title;
    state.progress = progress;
    state.courses = [];
    writeCourseLock('active', title);

    const allDone =
      progressNumber(progress) >= 100 ||
      (sections.length > 0 && sections.every((section) => progressNumber(section.progress) >= 100));
    if (allDone) {
      writeCourseLock('completed', title);
      state.message = `✅ ${title || '当前课程'}已完成，6 秒后返回个人中心。`;
      if (!state.closingCourse) {
        state.closingCourse = true;
        setTimeout(returnToPersonPage, 6000);
      }
      return;
    }

    state.closingCourse = false;
    if (sections.length > 1) {
      const current = sections.find((section) => section.current);
      if (current) {
        state.message = `正在学习：${current.title}\n小节 ${current.progress}｜课程 ${progress || '计算中'}`;
        if (progressNumber(current.progress) >= 100) {
          const next = sections.find((section) => progressNumber(section.progress) < 100);
          if (next && safeClick(next.cell, 4000)) {
            state.message = `当前小节已完成，正在切换：${next.title}`;
          }
        }
      } else {
        const first = sections.find((section) => progressNumber(section.progress) < 100);
        if (first && safeClick(first.cell, 4000)) {
          state.message = `正在打开小节：${first.title}`;
        } else {
          state.message = `正在识别课程小节｜课程 ${progress || '计算中'}`;
        }
      }
    } else {
      state.message = `正在学习：${title || '当前课程'}\n进度：${progress || '等待平台更新'}`;
    }
  }

  function handlePersonPage() {
    state.courseTitle = '';
    state.progress = '';
    state.closingCourse = false;

    const courseLock = activeCourseLock();
    if (courseLock?.status === 'completed' || courseLock?.status === 'closed') {
      if (!state.personReloading) {
        state.personReloading = true;
        clearCourseLock();
        state.message = '上一门课程已完成，正在刷新列表…';
        setTimeout(() => location.reload(), 800);
      }
      return;
    }
    if (courseLock) {
      const lockTitle = courseLock.title || '当前课程';
      state.message = courseLock.status === 'active'
        ? `已有课程正在学习：${lockTitle}\n完成或关闭后才会打开下一门。`
        : `正在打开课程：${lockTitle}\n已阻止重复打开新标签页。`;
      return;
    }
    state.personReloading = false;

    const myCourses = findByText(
      '.user_my_nav_li, nav a, [role="tab"], [class*="nav"] a',
      ['我的课程'],
      false
    );
    if (myCourses && !hasActiveClass(myCourses)) {
      state.message = '正在切换到“我的课程”…';
      safeClick(myCourses, 2500);
      return;
    }

    const studying = findByText(
      '.user_my_nav_li_title, [role="tab"], [class*="tab"]',
      ['正在学习的课程'],
      true
    );
    if (studying && !hasActiveClass(studying)) {
      state.message = '正在进入“正在学习的课程”…';
      safeClick(studying, 2500);
      return;
    }

    const courses = collectCourses();
    state.courses = courses.map(({ title, progress, status }) => ({ title, progress, status }));
    if (!courses.length) {
      state.message = '脚本运行正常，正在等待课程列表加载。';
      return;
    }

    const target = courses.find((course) => progressNumber(course.progress) < 100);
    if (!target) {
      state.message = '🎉 当前列表中的课程均已完成。';
      return;
    }

    state.message = `发现待学课程：${target.title}\n当前进度：${target.progress}`;
    writeCourseLock('launching', target.title);
    if (safeClick(target.titleElement, COURSE_LAUNCH_TIMEOUT)) {
      state.message = `正在进入课程：${target.title}`;
    } else {
      clearCourseLock(TAB_ID);
    }
  }

  function automationTick() {
    if (!IS_TOP) return;
    ensureFloatingUI();

    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      state.actionLockedUntil = 0;
      state.closingCourse = false;
    }

    state.mode = detectMode();
    if (!getAutoEnabled()) {
      state.message = '自动学习已暂停；脚本仍在正常运行。';
      updateFloatingUI();
      return;
    }

    if (state.mode === 'login') {
      state.courseTitle = '';
      state.progress = '';
      state.courses = [];
      state.message = '脚本已正常启动，请先登录；登录后将自动继续。';
    } else if (state.mode === 'detail') {
      handleDetailPage();
    } else if (state.mode === 'person') {
      handlePersonPage();
    } else {
      state.courseTitle = '';
      state.progress = '';
      state.courses = [];
      state.message = '脚本已运行。请登录后打开“个人中心—我的课程”。';
    }
    updateFloatingUI();
  }

  function requestBridge(baseUrl, payload) {
    return new Promise((resolve, reject) => {
      const onSuccess = (response) => {
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (!data.ok) throw new Error('bridge_not_ready');
          resolve(data);
        } catch (error) {
          reject(error);
        }
      };
      const options = {
        method: 'POST',
        url: `${baseUrl}/api/report`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: 900,
        onload: onSuccess,
        onerror: () => reject(new Error('bridge_unreachable')),
        ontimeout: () => reject(new Error('bridge_timeout')),
      };
      try {
        GM_xmlhttpRequest(options);
      } catch (error) {
        fetch(options.url, {
          method: 'POST',
          headers: options.headers,
          body: options.data,
          cache: 'no-store',
        })
          .then(async (response) => onSuccess({ responseText: await response.text() }))
          .catch(reject);
      }
    });
  }

  function bridgeReport() {
    return {
      url: location.href,
      pageTitle: document.title,
      mode: state.mode,
      userName: getUserName(),
      courseTitle: state.courseTitle,
      progress: state.progress,
      message: state.message,
      autoEnabled: getAutoEnabled(),
      courses: state.courses,
      scriptVersion: VERSION,
    };
  }

  function applyBridgeCommands(data) {
    const commandRevision = Number(data.commandRevision || 0);
    if (state.lastCommandRevision === null || commandRevision !== state.lastCommandRevision) {
      state.lastCommandRevision = commandRevision;
      if (typeof data.desiredRunning === 'boolean' && data.desiredRunning !== getAutoEnabled()) {
        setAutoEnabled(data.desiredRunning);
        state.message = data.desiredRunning
          ? '桌面端已启动自动学习。'
          : '桌面端已暂停自动学习。';
      }
    }

    const refreshRevision = Number(data.refreshRevision || 0);
    if (state.lastRefreshRevision === null) {
      state.lastRefreshRevision = refreshRevision;
    } else if (refreshRevision !== state.lastRefreshRevision) {
      state.lastRefreshRevision = refreshRevision;
      location.reload();
    }
  }

  let bridgeSyncBusy = false;
  async function syncBridge() {
    if (!IS_TOP || bridgeSyncBusy) return;
    bridgeSyncBusy = true;
    const urls = state.preferredBridge
      ? [state.preferredBridge, ...BRIDGE_URLS.filter((url) => url !== state.preferredBridge)]
      : BRIDGE_URLS;
    let connected = false;
    for (const url of urls) {
      try {
        const data = await requestBridge(url, bridgeReport());
        state.preferredBridge = url;
        state.bridgeConnected = true;
        applyBridgeCommands(data);
        connected = true;
        break;
      } catch (_error) {}
    }
    if (!connected) state.bridgeConnected = false;
    bridgeSyncBusy = false;
    updateFloatingUI();
  }

  function start() {
    console.info(`[青岛网院助手] v${VERSION} 已载入：${location.href}`);
    if (IS_TOP) {
      window.addEventListener('pagehide', releaseOwnedCourseLock);
      window.addEventListener('beforeunload', releaseOwnedCourseLock);
      ensureFloatingUI();
      automationTick();
      syncBridge();
      setInterval(automationTick, 2500);
      setInterval(syncBridge, 3000);
      new MutationObserver(() => ensureFloatingUI()).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
    autoPlayTick();
    setInterval(autoPlayTick, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
