// ==UserScript==
// @name         青岛干部网络学院 - 自动课程学习助手
// @namespace    https://www.qdgbjy.gov.cn/
// @version      3.2.9
// @description  普通课程与网上专题班手动分流学习，两个流程互不干扰，并与可选桌面端同步状态。
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
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '3.2.9';
  const PERSON_URL = 'https://www.qdgbjy.gov.cn/person';
  const STORAGE_KEY_AUTO = 'qdgbjy_auto_study_enabled_v3';
  const STORAGE_KEY_STUDY_MODE = 'qdgbjy_study_mode_v311';
  const STORAGE_KEY_COURSE_LOCK = 'qdgbjy_course_tab_lock_v311';
  const STORAGE_KEY_COURSE_RETURN = 'qdgbjy_course_return_v311';
  const STORAGE_KEY_SPECIAL_CLASS = 'qdgbjy_special_class_context_v311';
  const STORAGE_KEY_SPECIAL_DONE = 'qdgbjy_special_classes_done_v311';
  const STORAGE_KEY_SPECIAL_SCAN = 'qdgbjy_special_scan_done_v311';
  const STORAGE_KEY_SPECIAL_SKIP = 'qdgbjy_special_skipped_v316';
  const COURSE_LAUNCH_TIMEOUT = 120000;
  const COURSE_ACTIVE_TIMEOUT = 6 * 60 * 60 * 1000;
  const SPECIAL_DONE_TTL = 6 * 60 * 60 * 1000;
  const SPECIAL_SCAN_TTL = 30 * 60 * 1000;
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
    endedVideoAt: 0,
    personReloading: false,
    lastUrl: location.href,
    modeEnteredAt: Date.now(),
    specialApiCourses: [],
    specialApiTotal: 0,
    specialApiPage: 1,
    specialApiPageSize: 0,
    specialApiLoading: false,
    specialApiSeen: false,
    currentSpecialTarget: null,
    skippingCourse: false,
    lastSkipClickAt: 0,
    paginationAttempt: null,
  };

  // Observe the site's own list response and current page; do not send extra requests.
  function observeSpecialCourseResponse() {
    try {
      const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const proto = page.XMLHttpRequest.prototype;
      if (proto.__qdSpecialObserved) return;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      proto.open = function (method, url, ...rest) {
        this.__qdSpecialCourseRequest = /\/classInfoCenter\/getCourseDetailList(?:\?|$)/.test(String(url));
        this.__qdSpecialCourseUrl = String(url);
        return originalOpen.call(this, method, url, ...rest);
      };
      proto.send = function (...args) {
        if (this.__qdSpecialCourseRequest) {
          state.specialApiLoading = true;
          let requestedPage = 0;
          let requestedSize = 0;
          try {
            let body = args[0];
            if (typeof body === 'string') {
              try { body = JSON.parse(body); }
              catch (_error) { body = Object.fromEntries(new URLSearchParams(body)); }
            } else if (body instanceof FormData || body instanceof URLSearchParams) {
              body = Object.fromEntries(body);
            }
            requestedPage = Number(body?.pageNum || body?.page || body?.current) || 0;
            requestedSize = Number(body?.pageSize || body?.size) || 0;
          } catch (_error) {}
          try {
            const query = new URL(this.__qdSpecialCourseUrl, location.href).searchParams;
            requestedPage ||= Number(query.get('pageNum') || query.get('page')) || 0;
            requestedSize ||= Number(query.get('pageSize') || query.get('size')) || 0;
          } catch (_error) {}
          this.addEventListener('loadend', () => {
            try {
              const value = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              if (value?.code !== 0 || !Array.isArray(value?.data?.rows)) return;
              state.specialApiCourses = value.data.rows.map((row) => ({
                id: String(row.courseId || ''),
                title: String(row.courseName || '').trim(),
                progress: Number.parseFloat(row.courseProgress) || 0,
              })).filter((row) => row.title);
              state.specialApiTotal = Number(value.data.total) || state.specialApiCourses.length;
              state.specialApiSeen = true;
              if (requestedPage) state.specialApiPage = requestedPage;
              if (requestedSize) state.specialApiPageSize = requestedSize;
              else if (!state.specialApiPageSize) state.specialApiPageSize = state.specialApiCourses.length;
              state.paginationAttempt = null;
            } catch (_error) {} finally { state.specialApiLoading = false; }
          }, { once: true });
        }
        return originalSend.apply(this, args);
      };
      proto.__qdSpecialObserved = true;
    } catch (_error) {}
  }
  observeSpecialCourseResponse();

  function readLocalJson(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function writeLocalJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function removeLocalValue(key) {
    try {
      localStorage.removeItem(key);
    } catch (_error) {}
  }

  function specialClassKey(url = location.href) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.searchParams.get('trainClassId') || parsed.searchParams.get('id') || parsed.pathname;
    } catch (_error) { return 'unknown-class'; }
  }

  function specialPageStorageKey(classKey = specialClassKey()) {
    return `qdgbjy_special_resume_page_v316_${classKey}`;
  }


  function visibleSpecialPage() {
    const activeNumber = document.querySelector(
      '.isQiantai.pagination-container .el-pager li.is-active.number, .el-pager li.is-active.number'
    );
    return Number.parseInt(textOf(activeNumber), 10) || state.specialApiPage;
  }

  function skippedSpecialCourses(classKey) {
    const all = readLocalJson(STORAGE_KEY_SPECIAL_SKIP, {});
    return Array.isArray(all?.[classKey]) ? all[classKey] : [];
  }

  function courseIdentity(course) {
    return course?.id ? `id:${course.id}` : `title:${String(course?.title || '').trim()}`;
  }

  function sameSpecialCourse(left, right) {
    if (left?.id && right?.id) return String(left.id) === String(right.id);
    return Boolean(left?.title && right?.title && left.title === right.title);
  }

  function skipSpecialCourse(classKey, course) {
    if (!course?.title) return;
    const all = readLocalJson(STORAGE_KEY_SPECIAL_SKIP, {});
    const saved = all && typeof all === 'object' ? all : {};
    const previous = skippedSpecialCourses(classKey);
    const entry = { id: String(course.id || ''), title: String(course.title).slice(0, 300) };
    if (!previous.some((item) => sameSpecialCourse(item, entry))) {
      saved[classKey] = [...previous, entry];
      writeLocalJson(STORAGE_KEY_SPECIAL_SKIP, saved);
    }
  }

  function isSpecialCourseSkipped(classKey, course) {
    return skippedSpecialCourses(classKey).some((item) =>
      sameSpecialCourse(item, course));
  }

  function restoreLastSpecialSkip(classKey) {
    const all = readLocalJson(STORAGE_KEY_SPECIAL_SKIP, {});
    const previous = skippedSpecialCourses(classKey);
    if (!previous.length) return null;
    const restored = previous[previous.length - 1];
    all[classKey] = previous.slice(0, -1);
    writeLocalJson(STORAGE_KEY_SPECIAL_SKIP, all);
    return restored;
  }

  function setCourseReturnContext(kind, url, classTitle = '', course = null) {
    if (!url) {
      removeLocalValue(STORAGE_KEY_COURSE_RETURN);
      return;
    }
    writeLocalJson(STORAGE_KEY_COURSE_RETURN, {
      kind,
      url: String(url),
      classTitle: String(classTitle || '').slice(0, 300),
      courseId: String(course?.id || ''),
      courseTitle: String(course?.title || '').slice(0, 300),
      at: Date.now(),
    });
  }

  function readCourseReturnContext() {
    const value = readLocalJson(STORAGE_KEY_COURSE_RETURN);
    return value && typeof value.url === 'string' && typeof value.at === 'number' ? value : null;
  }

  function detectDetailPath() {
    return /\/detail(?:There)?(?:\/|$)/i.test(location.pathname);
  }

  function resolvedCourseReturnContext() {
    const stored = readCourseReturnContext();
    const classId = new URL(location.href).searchParams.get('trainClassId');
    if (!detectDetailPath()) return stored;
    if (!classId) {
      if (stored?.kind === 'special') {
        removeLocalValue(STORAGE_KEY_COURSE_RETURN);
        return null;
      }
      return stored;
    }
    if (stored?.kind === 'special' && specialClassKey(stored.url) === classId) return stored;
    if (stored) removeLocalValue(STORAGE_KEY_COURSE_RETURN);
    const classContext = readLocalJson(STORAGE_KEY_SPECIAL_CLASS, {});
    const candidates = [classContext?.classUrl, document.referrer];
    try { if (window.opener && !window.opener.closed) candidates.push(window.opener.location.href); }
    catch (_error) {}
    const classUrl = candidates.find((candidate) => {
      if (!candidate) return false;
      try {
        const url = new URL(candidate, location.href);
        return url.origin === location.origin && /\/trainDetail(?:\/|$)/i.test(url.pathname) &&
          url.searchParams.get('trainClassId') === classId;
      } catch (_error) { return false; }
    }) || '';
    const context = {
      kind: 'special', url: classUrl, courseId: '',
      courseTitle: currentCourseTitle(), at: Date.now(),
    };
    if (classUrl) setCourseReturnContext('special', classUrl, '', context);
    return context;
  }

  function readSpecialClassContext() {
    const value = readLocalJson(STORAGE_KEY_SPECIAL_CLASS);
    if (!value || typeof value.at !== 'number') return null;
    if (Date.now() - value.at > SPECIAL_DONE_TTL) {
      removeLocalValue(STORAGE_KEY_SPECIAL_CLASS);
      return null;
    }
    return value;
  }

  function writeSpecialClassContext(value) {
    writeLocalJson(STORAGE_KEY_SPECIAL_CLASS, {
      title: String(value?.title || '').slice(0, 300),
      listUrl: String(value?.listUrl || ''),
      classUrl: String(value?.classUrl || ''),
      at: Date.now(),
    });
  }

  function clearSpecialClassContext() {
    removeLocalValue(STORAGE_KEY_SPECIAL_CLASS);
  }

  function recentSpecialDoneTitles() {
    const now = Date.now();
    const stored = readLocalJson(STORAGE_KEY_SPECIAL_DONE, {});
    const clean = {};
    if (stored && typeof stored === 'object') {
      for (const [title, at] of Object.entries(stored)) {
        if (typeof at === 'number' && now - at < SPECIAL_DONE_TTL) clean[title] = at;
      }
    }
    if (Object.keys(clean).length !== Object.keys(stored || {}).length) {
      writeLocalJson(STORAGE_KEY_SPECIAL_DONE, clean);
    }
    return new Set(Object.keys(clean));
  }

  function markSpecialClassDone(title) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || cleanTitle === '未命名专题班') return;
    const stored = readLocalJson(STORAGE_KEY_SPECIAL_DONE, {});
    const value = stored && typeof stored === 'object' ? stored : {};
    value[cleanTitle] = Date.now();
    writeLocalJson(STORAGE_KEY_SPECIAL_DONE, value);
  }

  function specialScanRecentlyDone() {
    const at = Number(readLocalJson(STORAGE_KEY_SPECIAL_SCAN, 0));
    return Number.isFinite(at) && at > 0 && Date.now() - at < SPECIAL_SCAN_TTL;
  }

  function markSpecialScanDone() {
    writeLocalJson(STORAGE_KEY_SPECIAL_SCAN, Date.now());
  }

  function clearSpecialScanDone() {
    removeLocalValue(STORAGE_KEY_SPECIAL_SCAN);
  }

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
    if (lock.status === 'completed' || lock.status === 'closed' || lock.status === 'skipped') return lock;
    if ((lock.status === 'launching' || lock.status === 'active') && age < timeout) return lock;
    clearCourseLock();
    return null;
  }

  function getStudyMode() {
    try {
      const value = GM_getValue(STORAGE_KEY_STUDY_MODE, 'idle');
      return ['normal', 'special'].includes(value) ? value : 'idle';
    } catch (_error) {
      try {
        const value = localStorage.getItem(STORAGE_KEY_STUDY_MODE);
        return ['normal', 'special'].includes(value) ? value : 'idle';
      } catch (_ignored) {
        return 'idle';
      }
    }
  }

  function setStudyMode(mode) {
    const next = ['normal', 'special'].includes(mode) ? mode : 'idle';
    const previous = getStudyMode();
    try {
      GM_setValue(STORAGE_KEY_STUDY_MODE, next);
    } catch (_error) {
      try {
        localStorage.setItem(STORAGE_KEY_STUDY_MODE, next);
      } catch (_ignored) {}
    }
    if (next !== previous) {
      clearCourseLock();
      removeLocalValue(STORAGE_KEY_COURSE_RETURN);
      state.personReloading = false;
      state.actionLockedUntil = 0;
      if (next !== 'special') clearSpecialClassContext();
      if (next === 'special') clearSpecialScanDone();
    }
    return next;
  }

  function selectStudyMode(mode) {
    // Clicking the same mode again is an explicit retry after closing a class tab.
    if (mode === 'special' && getStudyMode() === 'special') clearSpecialClassContext();
    const next = setStudyMode(mode);
    setAutoEnabled(true);
    state.message = next === 'normal'
      ? '已选择“普通课程”模式：只学习个人中心课程，不进入网上专题班。'
      : '已选择“网上专题班”模式：只学习专题班，不进入普通课程。';
    updateFloatingUI();
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
      const itemText = textOf(item);
      const done = progressNumber(progress) >= 100 || /已完成|已学完|学习完成/.test(itemText);
      return {
        item,
        titleElement,
        actionElement: titleElement,
        title,
        progress: done && progressNumber(progress) < 100 ? '100%' : progress,
        status: done ? '已完成' : '学习中',
      };
    });
  }

  const SPECIAL_CLASS_JOIN_ACTIONS = ['点击参加', '立即参加', '参加'];
  const SPECIAL_CLASS_ENTER_ACTIONS = ['进入班级', '进入学习', '继续学习', '去学习', '查看班级'];
  const SPECIAL_CLASS_ACTIONS = [...SPECIAL_CLASS_JOIN_ACTIONS, ...SPECIAL_CLASS_ENTER_ACTIONS];
  const SPECIAL_COURSE_ACTIONS = ['开始学习', '继续学习', '立即学习', '进入学习', '去学习', '学习'];

  function visibleClickableElements() {
    return Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], [onclick]'))
      .filter(isVisible);
  }

  function nearestLogicalItem(element) {
    if (!element) return null;
    return (
      element.closest('tr, li, [class*="card"], [class*="Card"], [class*="item"], [class*="Item"], [class*="row"], [class*="Row"]') ||
      element.parentElement ||
      element
    );
  }

  function titleFromItem(item, actionText = '', fallback = '') {
    if (!item) return fallback;
    const selectors = [
      '[class*="title"]',
      '[class*="Title"]',
      '[class*="name"]',
      '[class*="Name"]',
      'td:first-child',
      'h1',
      'h2',
      'h3',
      'h4',
      'a',
    ];
    for (const selector of selectors) {
      for (const element of item.querySelectorAll(selector)) {
        const value = textOf(element);
        if (!value || value === actionText || value.length > 300) continue;
        if (SPECIAL_CLASS_ACTIONS.includes(value) || SPECIAL_COURSE_ACTIONS.includes(value)) continue;
        if (/^(已完成|已学完|学习完成|未开始|学习中|\d+(?:\.\d+)?\s*%)$/.test(value)) continue;
        return value;
      }
    }
    let value = textOf(item);
    for (const word of [...SPECIAL_CLASS_ACTIONS, ...SPECIAL_COURSE_ACTIONS, '已完成', '已学完', '学习完成']) {
      value = value.replaceAll(word, ' ');
    }
    value = value.replace(/\d+(?:\.\d+)?\s*%/g, ' ').replace(/\s+/g, ' ').trim();
    return value && value.length <= 300 ? value : fallback;
  }

  function collectSpecialClassActions() {
    const doneTitles = recentSpecialDoneTitles();
    const result = [];
    for (const element of visibleClickableElements()) {
      const action = textOf(element);
      if (!SPECIAL_CLASS_ACTIONS.includes(action)) continue;
      if (element.matches(':disabled, [disabled], [aria-disabled="true"]')) continue;
      const item = nearestLogicalItem(element);
      const title = titleFromItem(item, action, '未命名专题班');
      result.push({ element, item, action, title, recentlyDone: doneTitles.has(title) });
    }
    return result;
  }

  function collectSpecialCourses() {
    if (/\/trainDetail(?:\/|$)/i.test(location.pathname) && state.specialApiCourses.length) {
      return state.specialApiCourses.map((course) => {
        const titleElement = findVisibleCourseTitle(course.title);
        const actionElement = titleElement && findCourseEntryAction(titleElement);
        return {
          id: course.id,
          item: titleElement,
          titleElement,
          actionElement,
          title: course.title,
          progress: `${course.progress}%`,
          status: course.progress >= 100 ? '已完成' : '学习中',
        };
      });
    }
    const primary = collectCourses().filter((course) => isVisible(course.item));
    if (primary.length) return primary;

    const results = [];
    const seen = new Set();
    const addCourse = (item, actionElement = null, index = 0) => {
      if (!item || seen.has(item)) return;
      const itemText = textOf(item);
      if (!itemText || itemText.length > 1200) return;
      const actionText = textOf(actionElement);
      const title = titleFromItem(item, actionText, `未命名课程 ${index + 1}`);
      const progress = parseProgress(itemText) || (/已完成|已学完|学习完成/.test(itemText) ? '100%' : '0%');
      const done = progressNumber(progress) >= 100 || /已完成|已学完|学习完成/.test(itemText);
      const titleElement =
        item.querySelector('[class*="title"], [class*="Title"], [class*="name"], [class*="Name"], a[href*="course"], a[href*="detail"]') ||
        actionElement ||
        item;
      seen.add(item);
      results.push({
        item,
        titleElement,
        actionElement: actionElement || titleElement,
        title,
        progress: done ? '100%' : progress,
        status: done ? '已完成' : '学习中',
      });
    };

    let index = 0;
    for (const element of visibleClickableElements()) {
      const action = textOf(element);
      if (!SPECIAL_COURSE_ACTIONS.includes(action)) continue;
      const item = nearestLogicalItem(element);
      if (!item) continue;
      addCourse(item, element, index++);
    }

    const completedCandidates = Array.from(
      document.querySelectorAll('tr, li, [class*="course"], [class*="Course"], [class*="lesson"], [class*="Lesson"]')
    ).filter((item) => {
      if (!isVisible(item)) return false;
      const value = textOf(item);
      return value.length < 1200 && (/已完成|已学完|学习完成/.test(value) || /100\s*%/.test(value));
    });
    for (const item of completedCandidates) addCourse(item, null, index++);
    return results;
  }

  function findVisibleCourseTitle(title) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (value !== title || !isVisible(node.parentElement)) continue;
      return node.parentElement;
    }
    return null;
  }

  function findCourseEntryAction(titleElement) {
    let item = titleElement;
    for (let depth = 0; item && depth < 5; item = item.parentElement, depth++) {
      const button = Array.from(item.querySelectorAll('button,a,[role="button"]'))
        .find((element) => isVisible(element) && /学习|进入|播放/.test(textOf(element)));
      if (button) return button;
      if (item.matches('a,button,[role="button"]') || getComputedStyle(item).cursor === 'pointer') return item;
      if (item.matches('tr,li,[class*="item"],[class*="Item"],[class*="card"],[class*="Card"]')) return item;
    }
    return titleElement;
  }

  function findSpecialClassNav() {
    return visibleClickableElements().find((element) => {
      const value = textOf(element);
      return value === '网上专题班' || value === '专题班' || value.includes('网上专题班');
    });
  }

  function pageLooksLikeSpecialClassList() {
    const context = readSpecialClassContext();
    const bodyText = textOf(document.body);
    if (collectSpecialClassActions().length > 0 && /专题班|班级/.test(bodyText)) return true;
    if (context?.listUrl && location.href === context.listUrl) return true;
    if (context?.classUrl && location.href === context.classUrl) return false;
    if (/网上专题班/.test(bodyText) && /全部班级|班级列表/.test(bodyText)) return true;
    return collectSpecialClassActions().length > 0 && /专题班/.test(bodyText);
  }

  function pageLooksLikeSpecialClassCourseList() {
    const context = readSpecialClassContext();
    if (!context) return false;
    if (collectSpecialClassActions().length > 0) return false;
    if (collectSpecialCourses().length > 0 && /课程列表|班级课程|学习课程|专题班/.test(textOf(document.body))) return true;
    if (context.listUrl && location.href !== context.listUrl) return true;
    if (context.classUrl && location.href === context.classUrl) return true;
    const bodyText = textOf(document.body);
    if (context.listUrl === location.href) {
      if (findSpecialClassEntryLink(context.title)) return false;
    }
    return /课程列表|班级课程|学习课程/.test(bodyText) && collectSpecialCourses().length > 0;
  }

  function findSpecialClassEntryLink(title) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || cleanTitle === '未命名专题班') return null;
    const candidates = Array.from(document.querySelectorAll('tr, li, [class*="card"], [class*="item"], [class*="row"]'));
    const item = candidates.find((entry) => isVisible(entry) && textOf(entry).includes(cleanTitle));
    if (!item) return null;
    const clickables = Array.from(item.querySelectorAll('a, button, [role="button"], [onclick]')).filter(isVisible);
    return clickables.find((element) => SPECIAL_CLASS_ENTER_ACTIONS.includes(textOf(element))) ||
      clickables.find((element) => {
        const value = textOf(element);
        return !SPECIAL_CLASS_JOIN_ACTIONS.includes(value) && !/已参加|已完成/.test(value) && element.tagName === 'A';
      }) || null;
  }

  function adoptSpecialClassPageUrl() {
    const context = readSpecialClassContext();
    if (!context) return null;
    if (!context.classUrl && (!context.listUrl || location.href !== context.listUrl)) {
      context.classUrl = location.href;
      context.at = Date.now();
      writeSpecialClassContext(context);
    }
    return context;
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
    if (document.querySelector('.t1-cell, .xgplayer, #vedio-area video, video')) return 'detail';
    // trainDetail is the special-class course list, not an individual video detail.
    if (getStudyMode() === 'special' && /\/trainDetail(?:\/|$|\?|#)/i.test(path)) return 'special-class';
    if (/detail/i.test(path)) return 'detail';

    if (/\/person(?:\/|$|\?|#)/i.test(path)) return 'person';

    const studyMode = getStudyMode();
    if (studyMode === 'special') {
      if (pageLooksLikeSpecialClassCourseList()) return 'special-class';
      if (pageLooksLikeSpecialClassList()) return 'special-list';
      // The site opens its special-class pane over the personal page without changing the URL.
      if (readSpecialClassContext() && collectSpecialCourses().length > 0) return 'special-class';
    }

    if (/person/i.test(path)) return 'person';
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
          .mode-row { display:flex; gap:7px; margin-top:8px; }
          button { padding:8px 0; border:0; border-radius:6px; color:#fff; font-weight:700;
            font-size:13px; cursor:pointer; background:#2563eb; }
          .mode-row button { width:50%; background:#64748b; }
          .mode-row button.active { background:#2563eb; }
          .course-row { display:flex; gap:7px; margin-top:7px; }
          .course-row button { flex:1; padding:6px 3px; font-size:12px; background:#b45309; }
          .course-row button:disabled { cursor:default; opacity:.45; }
          #toggle { width:100%; margin-top:7px; }
          button.stop { background:#ef4444; }
        </style>
        <div class="box">
          <div class="head">
            <span class="title">● 青岛网院助手 v${VERSION}</span>
            <span id="status" class="tag running">脚本已启动</span>
          </div>
          <div id="info" class="info">脚本已载入，正在识别页面…</div>
          <div id="bridge" class="bridge">桌面端未连接（不影响脚本独立运行）</div>
          <div class="mode-row">
            <button id="normalMode" type="button">普通课程</button>
            <button id="specialMode" type="button">网上专题班</button>
          </div>
          <div class="course-row">
            <button id="skipCourse" type="button">跳过当前课程</button>
            <button id="restoreSkip" type="button">恢复上次跳过</button>
          </div>
          <button id="toggle" type="button">暂停当前模式</button>
        </div>`;
      shadow.getElementById('normalMode').addEventListener('click', () => selectStudyMode('normal'));
      shadow.getElementById('specialMode').addEventListener('click', () => selectStudyMode('special'));
      shadow.getElementById('skipCourse').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - state.lastSkipClickAt < 1500) return;
        state.lastSkipClickAt = Date.now();
        skipCurrentSpecialCourse();
      });
      shadow.getElementById('restoreSkip').addEventListener('click', () => {
        const restored = restoreLastSpecialSkip(specialClassKey());
        if (restored) state.message = `已恢复课程：${restored.title}`;
        updateFloatingUI();
      });
      shadow.getElementById('toggle').addEventListener('click', () => {
        if (getStudyMode() === 'idle') {
          state.message = '请先选择“普通课程”或“网上专题班”。';
          updateFloatingUI();
          return;
        }
        setAutoEnabled(!getAutoEnabled());
      });
    }
    return host.shadowRoot;
  }

  function updateFloatingUI() {
    const root = ensureFloatingUI();
    if (!root) return;
    const enabled = getAutoEnabled();
    const studyMode = getStudyMode();
    const tag = root.getElementById('status');
    const info = root.getElementById('info');
    const bridge = root.getElementById('bridge');
    const toggle = root.getElementById('toggle');
    const normalMode = root.getElementById('normalMode');
    const specialMode = root.getElementById('specialMode');
    const inDetail = state.mode === 'detail' || isSpecialDetailRoute();
    const returnContext = inDetail ? resolvedCourseReturnContext() : readCourseReturnContext();
    const inSpecialDetail = inDetail && returnContext?.kind === 'special';
    const classKey = inSpecialDetail ? specialClassKey(returnContext.url || location.href) : specialClassKey();
    const listTarget = state.mode === 'special-class' ? currentSpecialSkipTarget() : null;
    root.getElementById('skipCourse').disabled = studyMode !== 'special' ||
      !(listTarget || inSpecialDetail && (returnContext.courseTitle || currentCourseTitle()));
    root.getElementById('restoreSkip').disabled = studyMode !== 'special' ||
      state.mode !== 'special-class' || skippedSpecialCourses(classKey).length === 0;
    const modeLabel = studyMode === 'normal' ? '普通课程' : studyMode === 'special' ? '专题班' : '待选择';
    tag.textContent = enabled && studyMode !== 'idle' ? `${modeLabel}运行中` : modeLabel;
    tag.className = `tag ${enabled && studyMode !== 'idle' ? 'running' : 'paused'}`;
    info.textContent = state.message || '脚本运行正常。';
    bridge.textContent = state.bridgeConnected
      ? '桌面端已连接，状态与按钮可同步'
      : '桌面端未连接（不影响脚本独立运行）';
    normalMode.className = studyMode === 'normal' ? 'active' : '';
    specialMode.className = studyMode === 'special' ? 'active' : '';
    toggle.textContent = !enabled ? '▶ 继续当前模式' : '⏹ 暂停当前模式';
    toggle.className = enabled ? 'stop' : '';
  }

  function skipCurrentSpecialCourse() {
    if (getStudyMode() !== 'special') return;
    const inDetail = state.mode === 'detail' || isSpecialDetailRoute();
    const context = inDetail ? resolvedCourseReturnContext() : readCourseReturnContext();
    if (inDetail && context?.kind === 'special' && (context.courseTitle || currentCourseTitle())) {
      const classKey = specialClassKey(context.url || location.href);
      const courseTitle = context.courseTitle || currentCourseTitle();
      skipSpecialCourse(classKey, { id: context.courseId, title: courseTitle });
      state.skippingCourse = true;
      state.message = `仅跳过课程：${courseTitle}（本班共 ${skippedSpecialCourses(classKey).length} 条手动跳过记录），正在返回列表。`;
      writeCourseLock('skipped', courseTitle);
      updateFloatingUI();
      returnAfterCourse();
      return;
    }
    const target = state.mode === 'special-class' ? currentSpecialSkipTarget() : null;
    if (target) {
      skipSpecialCourse(specialClassKey(), target);
      const lock = readCourseLock();
      if (lock?.title === target.title) clearCourseLock();
      if (context?.kind === 'special' && context.courseTitle === target.title) {
        removeLocalValue(STORAGE_KEY_COURSE_RETURN);
      }
      state.actionLockedUntil = 0;
      state.currentSpecialTarget = null;
      state.message = `仅跳过课程：${target.title}（本班共 ${skippedSpecialCourses(specialClassKey()).length} 条手动跳过记录）。`;
      updateFloatingUI();
    }
  }

  function isSpecialDetailRoute() {
    return detectDetailPath() && new URL(location.href).searchParams.has('trainClassId');
  }

  function currentSpecialSkipTarget() {
    const lock = activeCourseLock();
    if (lock?.status === 'active' || lock?.status === 'launching') {
      const context = readCourseReturnContext();
      if (context?.kind === 'special' && specialClassKey(context.url) === specialClassKey() &&
          context.courseTitle === lock.title) {
        return { id: context.courseId, title: context.courseTitle };
      }
      const matches = state.specialApiCourses.filter((course) => course.title === lock.title);
      return matches.length === 1 ? matches[0] : null;
    }
    return state.currentSpecialTarget;
  }

  function autoPlayTick() {
    if (getStudyMode() === 'normal') {
      if (!new URL(location.href).searchParams.has('trainClassId')) autoPlayNormal304();
      return;
    }
    if (state.skippingCourse) return;
    const studyMode = getStudyMode();
    if (!getAutoEnabled() || studyMode === 'idle') return;
    if (detectMode() !== 'detail') return;
    const returnContext = resolvedCourseReturnContext();
    if (studyMode === 'normal' && returnContext?.kind === 'special') return;
    if (studyMode === 'special' && returnContext?.kind !== 'special') return;

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

  function returnAfterCourse() {
    const returnContext = resolvedCourseReturnContext();
    const targetUrl = returnContext?.kind === 'special' && returnContext.url
      ? returnContext.url
      : returnContext?.kind === 'special' ? '' : PERSON_URL;
    removeLocalValue(STORAGE_KEY_COURSE_RETURN);

    if (window.opener && !window.opener.closed) {
      window.close();
      setTimeout(() => {
        if (!window.closed) {
          if (targetUrl) location.assign(targetUrl);
          else history.back();
        }
      }, 1200);
      return;
    }
    if (targetUrl) location.assign(targetUrl);
    else history.back();
  }

  function returnToSpecialClassList(context) {
    const targetUrl = context?.listUrl || PERSON_URL;
    clearSpecialClassContext();
    removeLocalValue(STORAGE_KEY_COURSE_RETURN);
    setTimeout(() => location.assign(targetUrl), 1200);
  }

  function handleDetailPage() {
    if (state.skippingCourse) return;
    const studyMode = getStudyMode();
    const returnContext = resolvedCourseReturnContext();
    if (studyMode === 'normal' && returnContext?.kind === 'special') {
      state.message = '当前选择“普通课程”模式，本专题班课程页不执行自动学习。';
      return;
    }
    if (studyMode === 'special' && returnContext?.kind !== 'special') {
      state.message = '当前选择“网上专题班”模式，本普通课程页不执行自动学习。';
      return;
    }
    const sections = getSections();
    const progress = totalProgress(sections);
    const title = currentCourseTitle();
    const specialReturn = resolvedCourseReturnContext();
    const lockTitle = specialReturn?.kind === 'special' && specialReturn.courseTitle
      ? specialReturn.courseTitle : title;
    state.courseTitle = title;
    state.progress = progress;
    state.courses = [];

    // Keep the completion lock until the return timer fires. Rewriting it as
    // active on the next polling tick makes the list open the same course again.
    if (state.closingCourse) {
      state.message = `✅ ${title || '当前课程'}已完成，正在返回课程列表。`;
      return;
    }

    const allDone =
      progressNumber(progress) >= 100 ||
      (sections.length > 0 && sections.every((section) => progressNumber(section.progress) >= 100));
    if (allDone) {
      writeCourseLock('completed', lockTitle);
      const returnContext = resolvedCourseReturnContext();
      state.message = returnContext?.kind === 'special'
        ? `✅ ${title || '当前课程'}已完成，6 秒后返回专题班课程列表。`
        : `✅ ${title || '当前课程'}已完成，6 秒后返回个人中心。`;
      if (!state.closingCourse) {
        state.closingCourse = true;
        setTimeout(returnAfterCourse, 6000);
      }
      return;
    }

    writeCourseLock('active', lockTitle);
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length && videos.every((video) => video.ended)) {
      if (!state.endedVideoAt) state.endedVideoAt = Date.now();
      const refreshKey = `qdgbjy_detail_ended_refresh_v325_${lockTitle}`;
      if (Date.now() - state.endedVideoAt > 10000 && !sessionStorage.getItem(refreshKey)) {
        sessionStorage.setItem(refreshKey, '1');
        state.message = '视频已播完，正在刷新课程页同步完成进度…';
        setTimeout(() => location.reload(), 500);
        return;
      }
    } else {
      state.endedVideoAt = 0;
    }
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

  function handleSpecialClassListPage() {
    state.courseTitle = '';
    state.progress = '';
    state.closingCourse = false;
    state.courses = [];
    state.message = '请手动点击“点击参加”并进入专题班课程列表；进入后脚本将查找未完成课程。';
  }

  function advanceSpecialPage(restoring = false) {
    const currentPage = visibleSpecialPage();
    const next = document.querySelector(
      '.isQiantai.pagination-container .el-pagination button.btn-next'
    );
    if (!next) {
      state.message = '当前专题班页面未找到已确认的分页控件，已暂停自动翻页。';
      return;
    }
    if (next.disabled || next.getAttribute('aria-disabled') === 'true') {
      state.message = '已到末页；未完成课程均已学完或被手动跳过。';
      return;
    }
    if (!isVisible(next)) {
      state.message = '分页控件尚未显示，正在等待课程列表加载。';
      return;
    }
    if (state.paginationAttempt?.page === currentPage) {
      state.message = `等待第 ${currentPage + 1} 页加载；如未切换，请手动翻页。`;
      return;
    }
    if (!canAct()) return;
    state.paginationAttempt = { page: currentPage, at: Date.now() };
    if (safeClick(next, 5000)) {
      state.message = restoring
        ? `正在恢复到离开前的课程页：第 ${currentPage + 1} 页…`
        : `当前页已处理完，正在进入第 ${currentPage + 1} 页…`;
    } else {
      state.paginationAttempt = null;
    }
  }

  function handleSpecialClassCoursePage() {
    state.closingCourse = false;
    const context = adoptSpecialClassPageUrl() || readSpecialClassContext();
    const classTitle = context?.title || '网上专题班';
    state.courseTitle = classTitle;
    state.progress = '';

    const courseLock = activeCourseLock();
    if (courseLock?.status === 'completed' || courseLock?.status === 'closed' || courseLock?.status === 'skipped') {
      if (courseLock.status === 'completed') {
        if (Date.now() - courseLock.at < 8000) {
          state.message = `课程“${courseLock.title}”已完成，等待学习窗口返回并同步进度…`;
          return;
        }
        clearCourseLock();
        state.actionLockedUntil = 0;
        try { sessionStorage.setItem(specialPageStorageKey(), String(visibleSpecialPage())); }
        catch (_error) {}
        state.message = '课程已完成，正在刷新并恢复当前页进度…';
        setTimeout(() => location.reload(), 500);
        return;
      } else if (courseLock.status === 'skipped') {
        if (Date.now() - courseLock.at < 2500) {
          state.message = `已手动跳过“${courseLock.title}”，等待课程窗口返回…`;
          return;
        }
        clearCourseLock();
        try { sessionStorage.setItem(specialPageStorageKey(), String(visibleSpecialPage())); }
        catch (_error) {}
        state.message = '正在刷新课程列表并查找下一门未完成课程…';
        setTimeout(() => location.reload(), 500);
        return;
      } else {
        // A page refresh briefly closes the old document before the new one
        // takes over the lock. Wait before treating it as a closed window.
        if (Date.now() - courseLock.at < 15000) {
          state.message = `课程“${courseLock.title}”窗口暂时关闭，等待页面恢复…`;
          return;
        }
        clearCourseLock();
        try { sessionStorage.setItem(specialPageStorageKey(), String(visibleSpecialPage())); }
        catch (_error) {}
        state.message = '课程窗口已关闭，正在刷新列表后重新选择未完成课程…';
        setTimeout(() => location.reload(), 500);
        return;
      }
    }
    if (courseLock) {
      const lockTitle = courseLock.title || '当前课程';
      state.message = courseLock.status === 'active'
        ? `专题班课程正在学习：${lockTitle}\n完成后将自动返回班级继续下一门。`
        : `正在打开专题班课程：${lockTitle}\n已阻止重复打开。`;
      return;
    }
    state.personReloading = false;

    if (state.specialApiLoading || state.paginationAttempt) {
      state.message = state.paginationAttempt && Date.now() - state.paginationAttempt.at > 10000
        ? '自动翻页后列表未更新，请手动点击下一页；脚本不会跳回第一页。'
        : '正在等待当前页课程列表更新…';
      return;
    }
    if (!state.specialApiSeen) {
      state.message = '正在等待专题班课程接口返回最新进度…';
      return;
    }
    let resumePage = 0;
    try { resumePage = Number(sessionStorage.getItem(specialPageStorageKey())) || 0; } catch (_error) {}
    if (resumePage && state.specialApiCourses.length) {
      if (visibleSpecialPage() < resumePage) {
        advanceSpecialPage(true);
        return;
      }
      try { sessionStorage.removeItem(specialPageStorageKey()); } catch (_error) {}
    }

    const courses = collectSpecialCourses();
    const classKey = specialClassKey();
    state.courses = courses.map((course) => ({
      title: course.title,
      progress: course.progress,
      status: isSpecialCourseSkipped(classKey, course) ? '手动跳过' : course.status,
    }));
    if (!courses.length) {
      state.message = `已进入专题班“${classTitle}”，正在等待课程列表加载…`;
      return;
    }

    const target = courses.find((course) => course.status !== '已完成' &&
      progressNumber(course.progress) < 100 &&
      !isSpecialCourseSkipped(classKey, course));
    state.currentSpecialTarget = target || null;
    if (!target) {
      const skipped = state.courses.filter((course) => course.status === '手动跳过').length;
      state.message = `当前页没有可选课程（手动跳过 ${skipped} 门）。`;
      if (!state.specialApiLoading) advanceSpecialPage();
      return;
    }

    if (state.specialApiLoading) {
      state.message = '正在等待当前页课程列表更新…';
      return;
    }

    const targetElement = target.actionElement || target.titleElement || target.item;
    const excluded = state.courses.filter((course) =>
      course.status === '手动跳过');
    state.message = `专题班待学课程：${target.title}\n当前进度：${target.progress || '0%'}`;
    if (excluded.length) state.message += `\n本页排除：${excluded.map((course) =>
      `${course.title}（${course.status}）`).join('；').slice(0, 250)}`;
    if (!targetElement) {
      state.message += '\n接口已找到课程，页面中暂未找到对应课程入口。';
      return;
    }
    if (!canAct()) return;
    try { sessionStorage.setItem(specialPageStorageKey(), String(visibleSpecialPage())); } catch (_error) {}
    setCourseReturnContext('special', location.href, classTitle, target);
    writeCourseLock('launching', target.title);
    if (safeClick(targetElement, COURSE_LAUNCH_TIMEOUT)) {
      state.message = `正在进入专题班课程：${target.title}`;
    } else {
      clearCourseLock(TAB_ID);
      removeLocalValue(STORAGE_KEY_COURSE_RETURN);
    }
  }

  function handleSpecialModePersonPage() {
    state.courseTitle = '';
    state.progress = '';
    state.courses = [];
    state.closingCourse = false;
    const courseLock = activeCourseLock();
    if (courseLock?.status === 'completed' || courseLock?.status === 'closed') clearCourseLock();
    state.message = '请手动进入网上专题班并点击“点击参加”；脚本不会自动打开专栏。';
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
    removeLocalValue(STORAGE_KEY_COURSE_RETURN);
    writeCourseLock('launching', target.title);
    if (safeClick(target.titleElement, COURSE_LAUNCH_TIMEOUT)) {
      state.message = `正在进入课程：${target.title}`;
    } else {
      clearCourseLock(TAB_ID);
    }
  }


  function activeNormalCourseLock304() {
    const lock = readCourseLock();
    if (!lock) return null;
    const age = Date.now() - lock.at;
    const timeout = lock.status === 'launching' ? COURSE_LAUNCH_TIMEOUT : COURSE_ACTIVE_TIMEOUT;
    if (lock.status === 'completed' || lock.status === 'closed') return lock;
    if ((lock.status === 'launching' || lock.status === 'active') && age < timeout) return lock;
    clearCourseLock();
    return null;
  }


  // Ordinary-course implementation copied from the verified v3.0.4 release.
  function collectNormalCourses304() {
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

  function detectNormalMode304() {
    const path = `${location.pathname}${location.hash}`;
    if (/login|Login|webAuth/i.test(path)) return 'login';
    if (/detail/i.test(path)) return 'detail';
    if (/person/i.test(path)) return 'person';
    if (document.querySelector('.t1-cell, .xgplayer, #vedio-area video')) return 'detail';
    if (document.querySelector('.user_my_nav_li, .user_my_main_body_ul_li_1')) return 'person';
    return 'other';
  }

  function autoPlayNormal304() {
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

  function returnToPersonPage304() {
    if (window.opener && !window.opener.closed) {
      window.close();
      setTimeout(() => {
        if (!window.closed) location.assign(PERSON_URL);
      }, 1200);
      return;
    }
    location.assign(PERSON_URL);
  }

  function handleNormalDetailPage304() {
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
        setTimeout(returnToPersonPage304, 6000);
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

  function handleNormalPersonPage304() {
    state.courseTitle = '';
    state.progress = '';
    state.closingCourse = false;

    const courseLock = activeNormalCourseLock304();
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

    const courses = collectNormalCourses304();
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
      state.modeEnteredAt = Date.now();
    }

    const previousMode = state.mode;
    const studyMode = getStudyMode();
    state.mode = studyMode === 'normal' ? detectNormalMode304() : detectMode();
    if (state.mode !== previousMode) state.modeEnteredAt = Date.now();
    if (studyMode === 'idle') {
      state.courseTitle = '';
      state.progress = '';
      state.courses = [];
      state.message = '请选择学习模式：“普通课程”或“网上专题班”。两个流程将完全分开运行。';
      updateFloatingUI();
      return;
    }
    if (!getAutoEnabled()) {
      state.message = '当前学习模式已暂停；脚本仍在正常运行。';
      updateFloatingUI();
      return;
    }

    if (state.mode === 'login') {
      state.courseTitle = '';
      state.progress = '';
      state.courses = [];
      state.message = '脚本已正常启动，请先登录；登录后按已选择模式继续。';
    } else if (state.mode === 'detail') {
      if (studyMode === 'normal') {
        if (new URL(location.href).searchParams.has('trainClassId')) {
          state.message = '普通课程模式下不处理专题班课程页。';
        } else handleNormalDetailPage304();
      } else handleDetailPage();
    } else if (studyMode === 'special' && state.mode === 'special-list') {
      handleSpecialClassListPage();
    } else if (studyMode === 'special' && state.mode === 'special-class') {
      handleSpecialClassCoursePage();
    } else if (state.mode === 'person') {
      if (studyMode === 'special') handleSpecialModePersonPage();
      else handleNormalPersonPage304();
    } else {
      state.courseTitle = '';
      state.progress = '';
      state.courses = [];
      state.message = studyMode === 'normal'
        ? '普通课程模式已启用。请打开个人中心；不会进入网上专题班。'
        : '专题班模式已启用。请打开个人中心或网上专题班页面；不会操作普通课程。';
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
      studyMode: getStudyMode(),
      courses: state.courses,
      scriptVersion: VERSION,
    };
  }

  function applyBridgeCommands(data) {
    const commandRevision = Number(data.commandRevision || 0);
    if (state.lastCommandRevision === null || commandRevision !== state.lastCommandRevision) {
      state.lastCommandRevision = commandRevision;
      if (['normal', 'special'].includes(data.desiredStudyMode) && data.desiredStudyMode !== getStudyMode()) {
        setStudyMode(data.desiredStudyMode);
      }
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
