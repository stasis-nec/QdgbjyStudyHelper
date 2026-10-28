#!/usr/bin/env python3
"""青岛干部网络学院学习助手桌面端。

桌面端只在本机 127.0.0.1 上启动一个轻量桥接服务。油猴脚本负责读取网页、
执行页面操作并定时上报状态，因此不再依赖 AgentLimb 或 requests 第三方包。
"""

from __future__ import annotations

import argparse
import datetime
import ctypes
import json
import os
import shutil
import subprocess
import threading
import time
import tkinter as tk
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tkinter import messagebox, scrolledtext, ttk
from typing import Any
from pathlib import Path
from urllib.parse import urlparse, parse_qs


APP_VERSION = "3.3.5"
SITE_URL = "https://www.qdgbjy.gov.cn/person"
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORTS = (7791, 17791)
MAX_BODY_BYTES = 1024 * 1024
# Background tabs may answer recovery commands minutes or hours late.
RECOVERY_ACK_WARNING_SECONDS = 45
RECOVERY_PENDING_LOG_INTERVAL = 300
RECENT_CLASS_TAB_SECONDS = 95


class DiagnosticLog:
    """按本机日期追加纯文本诊断日志，不依赖界面，也不记录登录凭据。"""

    def __init__(self, directory: Path | None = None) -> None:
        if directory is None:
            if os.name == "nt":
                root = Path(os.environ.get("LOCALAPPDATA") or str(Path.home()))
            else:
                root = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local" / "state"))
            directory = root / "QdgbjyStudyHelper" / "logs"
        self.directory = Path(directory)
        self._lock = threading.Lock()
        self.error: str | None = None

    def write(self, message: str, level: str = "INFO") -> None:
        timestamp = datetime.datetime.now().astimezone()
        safe = str(message).replace("\r", " ").replace("\n", " | ").replace("\x00", "")[:1500]
        line = f"[{timestamp.strftime('%Y-%m-%d %H:%M:%S%z')}] [{level}] {safe}\n"
        with self._lock:
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
                path = self.directory / f"study_{timestamp:%Y-%m-%d}.log"
                with path.open("a", encoding="utf-8") as stream:
                    stream.write(line)
            except OSError as exc:
                self.error = str(exc)


class SystemSleepGuard:
    """自动学习期间阻止 Windows 进入系统睡眠，不阻止显示器关闭。"""

    ES_SYSTEM_REQUIRED = 0x00000001
    ES_CONTINUOUS = 0x80000000

    def __init__(self) -> None:
        self.enabled = False
        self.supported = os.name == "nt"

    def update(self, enabled: bool) -> str | None:
        enabled = bool(enabled)
        if not self.supported or enabled == self.enabled:
            return None
        flags = self.ES_CONTINUOUS | (self.ES_SYSTEM_REQUIRED if enabled else 0)
        try:
            result = ctypes.windll.kernel32.SetThreadExecutionState(flags)
        except (AttributeError, OSError):
            return None
        if not result:
            return None
        self.enabled = enabled
        return "enabled" if enabled else "disabled"


class ForegroundActivityPulse:
    """Optional Windows idle-input experiment; never clicks, types text, or acts in other apps."""

    INTERVAL = 240
    MIN_IDLE = 150
    VK_F15 = 0x7E
    KEYEVENTF_KEYUP = 0x0002
    MOUSEEVENTF_MOVE = 0x0001

    def __init__(self) -> None:
        self.supported = os.name == "nt"
        self.enabled = False
        self.last_pulse = time.monotonic()

    @staticmethod
    def _active_browser() -> bool:
        if os.name != "nt":
            return False
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.GetForegroundWindow.argtypes = ()
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        user32.GetWindowThreadProcessId.argtypes = (
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
        user32.GetWindowThreadProcessId.restype = ctypes.c_ulong
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return False
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        kernel32.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_int
        process = kernel32.OpenProcess(0x1000, False, pid.value)
        if not process:
            return False
        try:
            name = ctypes.create_unicode_buffer(2048)
            count = ctypes.c_ulong(len(name))
            kernel32.QueryFullProcessImageNameW.argtypes = (
                ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p,
                ctypes.POINTER(ctypes.c_ulong))
            kernel32.QueryFullProcessImageNameW.restype = ctypes.c_int
            if not kernel32.QueryFullProcessImageNameW(process, 0, name, ctypes.byref(count)):
                return False
            return name.value.replace("/", "\\").rsplit("\\", 1)[-1].lower() in {
                "msedge.exe", "chrome.exe", "firefox.exe", "brave.exe"
            }
        finally:
            kernel32.CloseHandle(process)

    @staticmethod
    def _idle_seconds() -> float:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]
        info = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
        user32 = ctypes.windll.user32
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return 0
        # Handle the Windows 32-bit tick counter rollover.
        return ((ctypes.windll.kernel32.GetTickCount() - info.dwTime) & 0xffffffff) / 1000

    def pulse_if_due(self, running: bool) -> bool:
        if not (self.supported and self.enabled and running):
            return False
        if time.monotonic() - self.last_pulse < self.INTERVAL:
            return False
        if not self._active_browser() or self._idle_seconds() < self.MIN_IDLE:
            return False
        try:
            user32 = ctypes.windll.user32
            # Move one pixel and immediately return; never change focus or click.
            user32.mouse_event(self.MOUSEEVENTF_MOVE, 1, 0, 0, 0)
            user32.mouse_event(self.MOUSEEVENTF_MOVE, -1, 0, 0, 0)
            # F15 is normally unassigned. No printable keys or Enter/Space are emitted.
            user32.keybd_event(self.VK_F15, 0, 0, 0)
            user32.keybd_event(self.VK_F15, 0, self.KEYEVENTF_KEYUP, 0)
            self.last_pulse = time.monotonic()
            return True
        except (AttributeError, OSError):
            self.enabled = False
            return False


class BridgeState:
    """线程安全地保存网页端上报状态和桌面端控制命令。"""

    def __init__(self, logger: DiagnosticLog | None = None) -> None:
        self._lock = threading.Lock()
        self.logger = logger
        self._seen_event_ids: set[str] = set()
        self._seen_event_order: list[str] = []
        self._pages: dict[str, tuple[dict[str, Any], float]] = {}
        self._active_account_key: str = ""
        self._tab_progress: dict[str, tuple[str, str, str]] = {}
        self._tab_progress_time: dict[str, float] = {}
        self._tab_heartbeat: dict[str, float] = {}
        self._tab_signatures: dict[str, tuple[str, str, str]] = {}
        self._latest_event: dict[str, str] = {}
        self._last_seen = 0.0
        self._page: dict[str, Any] = {
            "url": "",
            "pageTitle": "",
            "mode": "unknown",
            "userName": "",
            "courseTitle": "",
            "progress": "",
            "message": "等待油猴脚本连接",
            "autoEnabled": None,
            "studyMode": "idle",
            "courses": [],
            "diagnostics": {},
            "tabId": "",
        }
        self._desired_running: bool | None = None
        self._desired_study_mode: str | None = None
        self._command_revision = 0
        self._refresh_revision = 0
        self._watch_target: dict[str, Any] | None = None
        self._pending_recovery: dict[str, Any] | None = None
        self._last_recovery_issue = 0.0
        self._recovery_counts: dict[str, list[float]] = {}
        self._supervisor_message = ""
        self._last_supervisor_warning = ""

    @staticmethod
    def _clean_text(value: Any, limit: int) -> str:
        if value is None:
            return ""
        return str(value).replace("\x00", "").strip()[:limit]

    def _select_page_locked(self, now: float) -> dict[str, Any]:
        """Prefer a recent detail tab, even if background timers only run once/minute."""
        live = [(page, at) for page, at in self._pages.values()
                if now - at <= 95 and (not self._active_account_key or
                page.get("accountKey") == self._active_account_key)]
        detail = [(page, at) for page, at in live if page.get("mode") == "detail"
                  and (self._desired_study_mode is None
                       or page.get("studyMode") == self._desired_study_mode)]
        class_pages = [(page, at) for page, at in live if page.get("mode") == "special-class"]
        pool = detail or class_pages or live
        if not pool:
            return self._page
        page, at = max(pool, key=lambda item: item[1])
        result = dict(page)
        result["reportAgeSeconds"] = round(now - at, 1)
        result["delayedReport"] = now - at > 12
        return result

    def report(self, payload: dict[str, Any]) -> None:
        courses: list[dict[str, str]] = []
        raw_courses = payload.get("courses")
        if isinstance(raw_courses, list):
            for item in raw_courses[:200]:
                if not isinstance(item, dict):
                    continue
                courses.append(
                    {
                        "title": self._clean_text(item.get("title"), 300) or "未命名课程",
                        "progress": self._clean_text(item.get("progress"), 30) or "--",
                        "status": self._clean_text(item.get("status"), 50),
                    }
                )

        page = {
            "url": self._clean_text(payload.get("url"), 2000),
            "pageTitle": self._clean_text(payload.get("pageTitle"), 300),
            "mode": self._clean_text(payload.get("mode"), 50) or "unknown",
            "userName": self._clean_text(payload.get("userName"), 100),
            "accountKey": self._clean_text(payload.get("accountKey"), 32),
            "courseTitle": self._clean_text(payload.get("courseTitle"), 300),
            "progress": self._clean_text(payload.get("progress"), 30),
            "message": self._clean_text(payload.get("message"), 500),
            "autoEnabled": payload.get("autoEnabled")
            if isinstance(payload.get("autoEnabled"), bool)
            else None,
            "studyMode": self._clean_text(payload.get("studyMode"), 20)
            if self._clean_text(payload.get("studyMode"), 20) in {"normal", "special", "idle"}
            else "idle",
            "courses": courses,
            "diagnostics": {},
            "tabId": self._clean_text(payload.get("tabId"), 100) or
                     "legacy:" + self._clean_text(payload.get("mode"), 50) + ":" +
                     self._clean_text(payload.get("url"), 60),
            "progressSource": self._clean_text(payload.get("progressSource"), 40),
            "siteProgress": self._clean_text(payload.get("siteProgress"), 30),
            "courseKey": self._clean_text(payload.get("courseKey"), 300),
            "classId": self._clean_text(payload.get("classId"), 100),
        }
        raw_diag = payload.get("diagnostics")
        if isinstance(raw_diag, dict):
            page["diagnostics"] = {
                "status": self._clean_text(raw_diag.get("status"), 36),
                "videoTime": self._clean_text(raw_diag.get("videoTime"), 32),
                "videoDuration": self._clean_text(raw_diag.get("videoDuration"), 32),
                "videoState": self._clean_text(raw_diag.get("videoState"), 40),
                "section": self._clean_text(raw_diag.get("section"), 160),
                "stalledSeconds": self._clean_text(raw_diag.get("stalledSeconds"), 20),
                "progressIdleSeconds": self._clean_text(raw_diag.get("progressIdleSeconds"), 20),
                "documentHidden": bool(raw_diag.get("documentHidden")),
                "timingStrikes": self._clean_text(raw_diag.get("timingStrikes"), 10),
            }
        new_events: list[dict[str, str]] = []
        with self._lock:
            now = time.time()
            tab = page["tabId"]
            new_account = page["accountKey"]
            if page["mode"] == "login" and self._active_account_key:
                self._active_account_key = ""
                self._pages.clear()
                self._watch_target = None
                self._pending_recovery = None
                self._tab_progress.clear()
                self._tab_progress_time.clear()
                self._tab_heartbeat.clear()
                self._tab_signatures.clear()
                if self.logger:
                    self.logger.write("登录页面 | 暂时停止旧账号课程状态监控，等待当前登录身份。")
            # A freshly loaded person/class-list page establishes the active login.
            # Old player tabs remain in the browser but must not override the new
            # account's selection or trigger its recovery watchdog.
            if new_account and (not self._active_account_key or (
                    new_account != self._active_account_key and
                    page["mode"] in {"person", "special-list", "special-class"})):
                if self._active_account_key and self._active_account_key != new_account:
                    self._pages.clear()
                    self._watch_target = None
                    self._pending_recovery = None
                    self._recovery_counts.clear()
                    self._tab_progress.clear()
                    self._tab_progress_time.clear()
                    self._tab_heartbeat.clear()
                    self._tab_signatures.clear()
                    if self.logger:
                        self.logger.write("账号切换 | 已隔离旧账号页面和课程守护状态。")
                self._active_account_key = new_account
            if self._active_account_key and new_account != self._active_account_key:
                return  # Ignore old/unknown-account tabs after active login changed.
            self._pages[tab] = (page, now)
            # Browser-side manual pause cancels any request not yet delivered.
            pending = self._pending_recovery
            if (pending and page["autoEnabled"] is False and
                    tab in {pending["tabId"], pending["listTabId"]}):
                self._pending_recovery = None
                self._supervisor_message = "用户已暂停网页端学习，已取消待执行的课程恢复。"
                if self.logger:
                    self.logger.write("桌面守护/取消恢复 | " + self._supervisor_message)
            for expired in [key for key, (_value, seen) in self._pages.items() if now - seen > 180]:
                del self._pages[expired]
                self._tab_progress.pop(expired, None)
                self._tab_progress_time.pop(expired, None)
                self._tab_heartbeat.pop(expired, None)
                self._tab_signatures.pop(expired, None)
            if page["studyMode"] == "special" and page["mode"] == "detail" and page["classId"]:
                self._observe_detail_locked(page, now)
            ack = payload.get("recoveryAck")
            if (isinstance(ack, dict) and self._pending_recovery and
                    ack.get("id") == self._pending_recovery["id"] and
                    tab == self._pending_recovery["listTabId"]):
                outcome = ack.get("status")
                if outcome == "closed":
                    course = self._pending_recovery["courseKey"]
                    key = self._pending_recovery["countKey"]
                    self._recovery_counts.setdefault(key, []).append(now)
                    self._supervisor_message = f"已关闭并准备重新进入：{course}"
                    if self.logger:
                        self.logger.write(f"桌面守护/已确认关页 | 课程={course} | 第{len(self._recovery_counts[key])}/2次")
                    self._watch_target = None
                    self._pending_recovery = None
                elif outcome == "failed":
                    reason = self._clean_text(ack.get("reason"), 200)
                    self._supervisor_message = f"无法安全关闭课程标签：{reason}"
                    if self.logger:
                        self.logger.write(f"桌面守护/需要人工处理 | {self._supervisor_message}", "WARN")
                    self._desired_running = False
                    self._command_revision += 1
                    self._pending_recovery = None
            self._page = self._select_page_locked(now)
            self._last_seen = now
            for item in (payload.get("events") if isinstance(payload.get("events"), list) else [])[:32]:
                if not isinstance(item, dict):
                    continue
                event_id = self._clean_text(item.get("id"), 100)
                if not event_id or event_id in self._seen_event_ids:
                    continue
                self._seen_event_ids.add(event_id)
                self._seen_event_order.append(event_id)
                if len(self._seen_event_order) > 2048:
                    old = self._seen_event_order.pop(0)
                    self._seen_event_ids.discard(old)
                event = {
                    "id": event_id,
                    "kind": self._clean_text(item.get("kind"), 40) or "event",
                    "message": self._clean_text(item.get("message"), 500),
                    "course": self._clean_text(item.get("course"), 300),
                }
                self._latest_event = event
                new_events.append(event)
            progress_key = (page["studyMode"], page["courseTitle"], page["progress"])
            prior_key = self._tab_progress.get(tab)
            progress_to_log = (page["mode"] == "detail" and bool(page["courseTitle"])
                and bool(page["progress"]) and progress_key != prior_key
                and (now - self._tab_progress_time.get(tab, 0) >= 30
                     or prior_key is None or progress_key[:2] != prior_key[:2]))
            self._tab_progress[tab] = progress_key
            if progress_to_log:
                self._tab_progress_time[tab] = now
            page_signature = (page["studyMode"], page["mode"], page["courseTitle"])
            page_transition = page_signature != self._tab_signatures.get(tab)
            self._tab_signatures[tab] = page_signature
            heartbeat = (page["mode"] == "detail"
                         and now - self._tab_heartbeat.get(tab, 0) >= 300)
            if heartbeat:
                self._tab_heartbeat[tab] = now
        if self.logger is not None:
            if page_transition:
                self.logger.write(
                    f"网页状态切换 | 模式={page['studyMode']} | 页面={page['mode']} | "
                    f"课程={page['courseTitle'] or '-'} | 状态={page['message']}"
                )
            if heartbeat:
                diag = page["diagnostics"]
                self.logger.write(
                    f"五分钟心跳 | 课程={page['courseTitle'] or '-'} | 进度={page['progress']} | "
                    f"播放器={diag.get('status', '')} | 视频位置={diag.get('videoTime', '')} | "
                    f"进度未变化={diag.get('progressIdleSeconds', '')}秒 | "
                    f"播放时间未推进={diag.get('stalledSeconds', '')}秒"
                )
            for event in new_events:
                self.logger.write(
                    f"网页事件/{event['kind']} | 课程={event['course'] or '-'} | {event['message']}",
                    "WARN" if event["kind"] in {"warning", "stalled", "error"} else "INFO",
                )
            if progress_to_log:
                diag = page["diagnostics"]
                self.logger.write(
                    f"学习进度 | 模式={page['studyMode']} | 课程={page['courseTitle']} | "
                    f"进度={page['progress']} | 小节={diag.get('section', '')} | "
                    f"视频={diag.get('videoTime', '')}/{diag.get('videoDuration', '')} | "
                    f"进度来源={page['progressSource']} | 页面进度={page['siteProgress']} | "
                    f"状态={diag.get('status', '')}"
                )

    def _observe_detail_locked(self, page: dict[str, Any], now: float) -> None:
        """Timestamp video and section progress independently of JavaScript timers."""
        key = (page["classId"], page["courseKey"])
        if not all(key):
            return
        diag = page["diagnostics"]
        try:
            video_time = float(diag.get("videoTime", ""))
        except (TypeError, ValueError):
            video_time = None
        try:
            duration = float(diag.get("videoDuration", ""))
        except (TypeError, ValueError):
            duration = 0.0
        try:
            percent = float(page["progress"].rstrip("%"))
        except (ValueError, TypeError):
            percent = None
        section = diag.get("section") or ""
        old = self._watch_target
        # A newly opened or switched course/section starts a fresh observation.
        if not old or old["key"] != key or old["section"] != section:
            self._watch_target = dict(key=key, tabId=page["tabId"], classId=key[0],
                courseKey=key[1], section=section, videoTime=video_time, percent=percent,
                duration=duration, lastSeen=now, lastAdvance=now, status=diag.get("status", ""),
                active=page["autoEnabled"])
            return
        if old["tabId"] != page["tabId"]:
            # A newly opened document supersedes a frozen player: an old tab
            # close request is no longer safe to issue against its identity.
            pending = self._pending_recovery
            if (pending and pending["classId"] == key[0] and pending["courseKey"] == key[1]):
                self._pending_recovery = None
                if self.logger:
                    self.logger.write("桌面守护/取消恢复 | 检测到同课程新的播放标签，已撤销旧关页指令。")
            old.update(tabId=page["tabId"], lastAdvance=now, videoTime=video_time, percent=percent)
        elif ((video_time is not None and old["videoTime"] is not None and
               video_time > old["videoTime"] + 0.5) or
              (percent is not None and old["percent"] is not None and
               percent > old["percent"] + 0.01)):
            old["lastAdvance"] = now
            # A player that has resumed must not receive an old close request.
            pending = self._pending_recovery
            if (pending and pending["tabId"] == page["tabId"] and
                    pending["classId"] == key[0] and pending["courseKey"] == key[1]):
                self._pending_recovery = None
                self._supervisor_message = f"课程{key[1]}恢复推进，已取消过期关页请求。"
                if self.logger:
                    self.logger.write("桌面守护/取消恢复 | " + self._supervisor_message)
        old.update(videoTime=video_time, percent=percent, duration=duration,
                   lastSeen=now, status=diag.get("status", ""), active=page["autoEnabled"])

    def check_course_watchdog(self, now: float | None = None) -> None:
        """Independent 15-second desktop watchdog, including bridge-only mode."""
        if now is None:
            now = time.time()
        message = ""
        with self._lock:
            if self._desired_study_mode not in (None, "special") or self._desired_running is False:
                return
            # 3.3.3 turned off the *global* study switch after 45 seconds.
            # With Edge background throttling this is a normal response delay,
            # causing a successfully closed tab to leave study permanently paused.
            # Retain the targeted request until acknowledged, new progress is seen,
            # or the user manually pauses/switches modes. Never guess success.
            if self._pending_recovery:
                pending = self._pending_recovery
                age = now - pending["at"]
                if age >= RECOVERY_ACK_WARNING_SECONDS and now - pending.get("lastWarn", pending["at"]) >= (
                    RECOVERY_ACK_WARNING_SECONDS if not pending.get("warned") else RECOVERY_PENDING_LOG_INTERVAL
                ):
                    pending["warned"] = True
                    pending["lastWarn"] = now
                    course = pending["courseKey"]
                    self._supervisor_message = (f"课程{course}关页命令等待回应已{round(age)}秒；"
                        "专题班列表页可能被浏览器节流，学习模式保持运行，暂不重复下发命令。")
                    if self.logger:
                        self.logger.write("桌面守护/等待关页回执 | " + self._supervisor_message, "WARN")
                return
            watch = self._watch_target
            if not watch or self._pending_recovery:
                return
            if watch.get("status") in {"paused", "ended"} or watch.get("active") is not True:
                return
            # A manual pause from the browser must cancel autonomous recovery.
            recent_list = [item for item, at in self._pages.values()
                           if item["mode"] == "special-class" and
                           item["classId"] == watch["classId"] and now - at < RECENT_CLASS_TAB_SECONDS]
            if recent_list and not any(item["autoEnabled"] is True for item in recent_list):
                return
            # Two times one percent of section video length; minimum three minutes.
            threshold = max(180.0, min(900.0, 2 * max(0, watch["duration"]) / 100))
            elapsed = now - watch["lastAdvance"]
            if elapsed < threshold:
                return
            key = f"{watch['classId']}|{watch['courseKey']}"
            attempts = [v for v in self._recovery_counts.get(key, []) if now - v < 86400]
            self._recovery_counts[key] = attempts
            eligible = [(tab, item) for tab, (item, at) in self._pages.items()
                if item["mode"] == "special-class" and item["studyMode"] == "special"
                and item["classId"] == watch["classId"] and
                item["autoEnabled"] is True and now - at < 15]
            if len(attempts) >= 2:
                message = f"课程{watch['courseKey']}已到两次恢复上限，请人工检查。"
                self._desired_running = False
                self._command_revision += 1
                self._supervisor_message = message
                self._watch_target = None
            elif eligible:
                list_tab, _page = max(eligible, key=lambda entry: self._pages[entry[0]][1])
                req_id = f"{int(now * 1000)}-{watch['tabId']}"
                self._pending_recovery = {
                    "id": req_id, "tabId": watch["tabId"], "courseKey": watch["courseKey"],
                    "classId": watch["classId"], "listTabId": list_tab, "countKey": key,
                    "reason": f"课程进度和播放器持续{round(elapsed)}秒没有有效推进",
                    "at": now,
                }
                message = (f"桌面守护/请求恢复 | {watch['courseKey']} | 停滞{round(elapsed)}秒"
                    f" | 阈值{round(threshold)}秒 | 交由专题班列表页关闭原标签")
                self._supervisor_message = message
            else:
                msg = f"课程{watch['courseKey']}已停滞{round(elapsed)}秒，但专题班列表页不在线，无法安全关页。"
                if self._last_supervisor_warning != key:
                    message = "桌面守护/等待人工处理 | " + msg
                    self._last_supervisor_warning = key
                    self._supervisor_message = msg
        if message and self.logger:
            self.logger.write(message, "WARN" if "无法" in message or "上限" in message else "INFO")

    def set_running(self, enabled: bool) -> None:
        with self._lock:
            self._desired_running = bool(enabled)
            if not enabled:
                # Explicit human pause takes precedence over pending recovery.
                self._pending_recovery = None
            self._command_revision += 1

    def start_mode(self, mode: str) -> None:
        if mode not in {"normal", "special"}:
            raise ValueError(f"unsupported study mode: {mode}")
        with self._lock:
            self._desired_study_mode = mode
            self._desired_running = True
            # Explicit restart supersedes any stale recovery instruction.
            self._pending_recovery = None
            if self._watch_target:
                self._watch_target["lastAdvance"] = time.time()
            self._command_revision += 1

    def request_refresh(self) -> None:
        with self._lock:
            self._refresh_revision += 1

    def snapshot(self, recipient_tab: str = "") -> dict[str, Any]:
        with self._lock:
            now = time.time()
            age = now - self._last_seen if self._last_seen else None
            self._page = self._select_page_locked(now)
            recipient = self._pages.get(recipient_tab)
            recovery = self._pending_recovery if (
                recipient_tab and recipient and self._pending_recovery and
                self._pending_recovery["listTabId"] == recipient_tab and
                recipient[0]["mode"] == "special-class") else None
            return {
                "recoveryRequest": ({k: recovery[k] for k in ("id", "tabId", "courseKey", "classId", "reason")}
                                    if recovery else None),
                "supervisorMessage": self._supervisor_message,
                "guardianAvailable": bool(self._watch_target and any(
                    item["mode"] == "special-class" and
                    item["classId"] == self._watch_target["classId"] and
                    now - at < RECENT_CLASS_TAB_SECONDS for item, at in self._pages.values())),
                "ok": True,
                "appVersion": APP_VERSION,
                "online": age is not None and age < 75,
                "lastSeenSeconds": round(age, 1) if age is not None else None,
                "desiredRunning": self._desired_running,
                "desiredStudyMode": self._desired_study_mode,
                "commandRevision": self._command_revision,
                "refreshRevision": self._refresh_revision,
                "page": dict(self._page),
                "latestEvent": dict(self._latest_event),
            }


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_handler(state: BridgeState):
    class BridgeHandler(BaseHTTPRequestHandler):
        server_version = "QdgbjyBridge/3.0"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self._send_json(200, {"ok": True})

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = urlparse(self.path).path.rstrip("/")
            if path in {"", "/api/status", "/api/command"}:
                self._send_json(200, state.snapshot())
                return
            self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = urlparse(self.path).path.rstrip("/")
            if path != "/api/report":
                self._send_json(404, {"ok": False, "error": "not_found"})
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send_json(400, {"ok": False, "error": "invalid_body_length"})
                return

            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"ok": False, "error": "invalid_json"})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"ok": False, "error": "invalid_payload"})
                return

            state.report(payload)
            self._send_json(200, state.snapshot(recipient_tab=str(payload.get("tabId", ""))))

    return BridgeHandler


class LocalBridge:
    def __init__(self, state: BridgeState) -> None:
        self.state = state
        self.server: ReusableThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.port: int | None = None
        self.watchdog_stop = threading.Event()
        self.watchdog_thread: threading.Thread | None = None

    def start(self) -> int:
        errors: list[str] = []
        for port in BRIDGE_PORTS:
            try:
                self.server = ReusableThreadingHTTPServer(
                    (BRIDGE_HOST, port), make_handler(self.state)
                )
                self.port = port
                break
            except OSError as exc:
                errors.append(f"{port}: {exc}")
        if self.server is None or self.port is None:
            raise OSError("本机桥接服务无法启动；" + "；".join(errors))

        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name="qdgbjy-local-bridge",
            daemon=True,
        )
        self.thread.start()
        self.watchdog_stop.clear()
        self.watchdog_thread = threading.Thread(target=self._watch_loop,
            name="qdgbjy-desktop-watchdog", daemon=True)
        self.watchdog_thread.start()
        return self.port

    def _watch_loop(self) -> None:
        while not self.watchdog_stop.wait(15):
            try:
                self.state.check_course_watchdog()
            except Exception as exc:
                if self.state.logger:
                    self.state.logger.write(f"桌面守护内部异常：{exc}", "ERROR")

    def stop(self) -> None:
        self.watchdog_stop.set()
        if self.watchdog_thread is not None:
            self.watchdog_thread.join(timeout=2)
            self.watchdog_thread = None
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None


class StudyHelperApp:
    def __init__(self, root: tk.Tk, state: BridgeState, bridge: LocalBridge) -> None:
        self.root = root
        self.state = state
        self.bridge = bridge
        self.sleep_guard = SystemSleepGuard()
        self.activity_pulse = ForegroundActivityPulse()
        self.logger = state.logger
        self.settings_path = ((self.logger.directory.parent if self.logger else Path.home() / "QdgbjyStudyHelper")
                              / "settings.json")
        try:
            settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
            saved_pulse = settings.get("enableInputPulse") is True
        except (OSError, ValueError, AttributeError):
            saved_pulse = False
        self.activity_pulse_var = tk.BooleanVar(value=saved_pulse)
        self.activity_pulse.enabled = saved_pulse and self.activity_pulse.supported
        self.last_event_id = ""
        self.was_online = False
        self.last_log_signature: tuple[Any, ...] | None = None

        self.root.title(f"青岛干部网络学院 - 学习助手 v{APP_VERSION}")
        self.root.geometry("860x680")
        self.root.minsize(780, 580)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self._setup_style()
        self._build_ui()
        self.log("桌面端已启动。连接网页后，请手动选择“普通课程”或“网上专题班”。")
        if self.logger:
            self.log(f"日志目录：{self.logger.directory}")
            if self.logger.error:
                messagebox.showwarning("日志保存异常", f"无法写入日志：{self.logger.error}")
        self.root.after(300, self.refresh_status)

    def _setup_style(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(".", font=("Microsoft YaHei UI", 9))
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 10, "bold"), foreground="#1a56db")
        style.configure("Accent.TButton", font=("Microsoft YaHei UI", 10, "bold"), padding=6)
        style.configure("Success.TLabel", foreground="#0e9f6e", font=("Microsoft YaHei UI", 9, "bold"))
        style.configure("Warn.TLabel", foreground="#e02424", font=("Microsoft YaHei UI", 9, "bold"))

    def _build_ui(self) -> None:
        top_frame = ttk.LabelFrame(self.root, text=" 运行与登录状态 ", padding=10)
        top_frame.pack(fill="x", padx=12, pady=6)

        self.lbl_bridge = ttk.Label(top_frame, text="● 油猴脚本: 等待连接", style="Warn.TLabel")
        self.lbl_bridge.grid(row=0, column=0, sticky="w", padx=10)
        self.lbl_user = ttk.Label(top_frame, text="● 登录学员: 未检测到")
        self.lbl_user.grid(row=0, column=1, sticky="w", padx=20)
        self.lbl_page = ttk.Label(top_frame, text="当前页面: 暂无", foreground="#6b7280")
        self.lbl_page.grid(row=0, column=2, sticky="w", padx=10)
        self.lbl_mode = ttk.Label(top_frame, text="学习模式: 未选择", foreground="#1a56db")
        self.lbl_mode.grid(row=1, column=0, columnspan=3, sticky="w", padx=10, pady=(6, 0))
        top_frame.columnconfigure(2, weight=1)

        current_frame = ttk.LabelFrame(self.root, text=" 当前学习监控 ", padding=12)
        current_frame.pack(fill="x", padx=12, pady=6)
        self.lbl_curr_title = ttk.Label(
            current_frame,
            text="当前未在学习任何课程",
            style="Title.TLabel",
            wraplength=700,
        )
        self.lbl_curr_title.pack(anchor="w", pady=(0, 6))

        prog_box = ttk.Frame(current_frame)
        prog_box.pack(fill="x", pady=4)
        self.progress_bar = ttk.Progressbar(prog_box, orient="horizontal", mode="determinate", length=600)
        self.progress_bar.pack(side="left", fill="x", expand=True, padx=(0, 15))
        self.lbl_percent = ttk.Label(
            prog_box,
            text="0%",
            font=("Microsoft YaHei UI", 11, "bold"),
            foreground="#1a56db",
            width=6,
        )
        self.lbl_percent.pack(side="right")
        self.lbl_health = ttk.Label(current_frame, text="播放诊断：等待网页信息", foreground="#6b7280")
        self.lbl_health.pack(anchor="w", pady=(4, 0))

        btn_frame = ttk.Frame(self.root, padding=6)
        btn_frame.pack(fill="x", padx=12)
        self.btn_normal = ttk.Button(
            btn_frame,
            text="▶ 学普通课程",
            style="Accent.TButton",
            command=self.start_normal_study,
        )
        self.btn_normal.pack(side="left", padx=5)
        self.btn_special = ttk.Button(
            btn_frame,
            text="▶ 学网上专题班",
            style="Accent.TButton",
            command=self.start_special_study,
        )
        self.btn_special.pack(side="left", padx=5)
        self.btn_stop = ttk.Button(btn_frame, text="⏹ 暂停当前模式", command=self.stop_study)
        self.btn_stop.pack(side="left", padx=5)
        self.chk_activity = ttk.Checkbutton(
            self.root, text="实验：空闲时模拟鼠标微动及F15（仅浏览器前台）",
            variable=self.activity_pulse_var, command=self.toggle_activity_pulse)
        self.chk_activity.pack(anchor="w", padx=23, pady=(0, 3))
        self.btn_refresh = ttk.Button(btn_frame, text="🔄 刷新当前网页", command=self.manual_refresh)
        self.btn_refresh.pack(side="left", padx=5)
        self.btn_open_edge = ttk.Button(btn_frame, text="🌐 打开个人中心", command=self.open_website)
        self.btn_open_edge.pack(side="right", padx=5)
        self.btn_logs = ttk.Button(btn_frame, text="📂 打开日志目录", command=self.open_log_directory)
        self.btn_logs.pack(side="right", padx=5)

        mid_frame = ttk.LabelFrame(self.root, text=" 正在学习的课程列表 ", padding=8)
        mid_frame.pack(fill="both", expand=True, padx=12, pady=6)
        columns = ("id", "title", "prog", "status")
        self.tree = ttk.Treeview(mid_frame, columns=columns, show="headings", height=5)
        self.tree.heading("id", text="序号")
        self.tree.heading("title", text="课程名称")
        self.tree.heading("prog", text="当前进度")
        self.tree.heading("status", text="状态")
        self.tree.column("id", width=50, anchor="center")
        self.tree.column("title", width=480, anchor="w")
        self.tree.column("prog", width=90, anchor="center")
        self.tree.column("status", width=90, anchor="center")
        tree_scroll = ttk.Scrollbar(mid_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=tree_scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        tree_scroll.pack(side="right", fill="y")

        log_frame = ttk.LabelFrame(self.root, text=" 实时运行日志 ", padding=6)
        log_frame.pack(fill="both", expand=True, padx=12, pady=(0, 8))
        self.log_text = scrolledtext.ScrolledText(
            log_frame,
            height=7,
            font=("Consolas", 9),
            wrap="word",
            bg="#f9fafb",
        )
        self.log_text.pack(fill="both", expand=True)

    def log(self, message: str, persist: bool = True) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {message}\n"
        self.log_text.insert("end", line)
        self.log_text.see("end")
        if int(self.log_text.index("end-1c").split(".")[0]) > 1200:
            self.log_text.delete("1.0", "201.0")
        if persist and self.logger:
            self.logger.write(message)

    @staticmethod
    def _progress_number(value: str) -> int:
        try:
            return max(0, min(100, int(float(value.replace("%", "").strip()))))
        except (TypeError, ValueError, AttributeError):
            return 0

    def refresh_status(self) -> None:
        snap = self.state.snapshot()
        page = snap["page"]
        online = bool(snap["online"])

        if self.was_online and not online:
            self.log("网页连接中断，可能是标签页休眠、电脑睡眠、浏览器关闭或网络异常。")
        elif not self.was_online and online:
            self.log("网页已连接到桌面助手。")
        self.was_online = online
        if online:
            self.lbl_bridge.config(text="● 油猴脚本: 在线连通", style="Success.TLabel")
        else:
            self.lbl_bridge.config(text="● 油猴脚本: 未连接（请用已装油猴的浏览器刷新）", style="Warn.TLabel")

        user_name = page.get("userName") or "未检测到"
        self.lbl_user.config(text=f"● 登录学员: {user_name}")
        page_label = {
            "login": "登录页",
            "person": "个人中心",
            "detail": "课程学习页",
            "special-list": "网上专题班-班级列表",
            "special-class": "网上专题班-课程列表",
            "other": "网站其他页面",
            "unknown": "暂无",
        }.get(page.get("mode"), page.get("mode") or "暂无")
        self.lbl_page.config(text=f"当前页面: {page_label}")
        study_mode = page.get("studyMode") or snap.get("desiredStudyMode") or "idle"
        if snap.get("desiredStudyMode") in {"normal", "special"}:
            study_mode = snap.get("desiredStudyMode")
        mode_label = {"normal": "普通课程", "special": "网上专题班", "idle": "未选择"}.get(study_mode, "未选择")
        self.lbl_mode.config(text=f"学习模式: {mode_label}")

        title = page.get("courseTitle") or page.get("message") or "当前未在学习任何课程"
        self.lbl_curr_title.config(text=title)
        progress = page.get("progress") or "0%"
        self.progress_bar.config(value=self._progress_number(progress))
        self.lbl_percent.config(text=progress)
        diag = page.get("diagnostics") or {}
        video_info = f"视频 {diag.get('videoTime', '-')}/{diag.get('videoDuration', '-')}秒"
        health_text = (f"播放诊断：{diag.get('status') or '等待播放器信息'} | "
                       f"{video_info} | 小节：{diag.get('section') or '-'}")
        source = page.get("progressSource") or "-"
        age = page.get("reportAgeSeconds", 0)
        if page.get("mode") == "detail":
            health_text += f" | 进度来源:{source}"
            strikes = diag.get("timingStrikes", "")
            if strikes and strikes != "0":
                health_text += f" | 冻结异常:{strikes}/2"
        if page.get("delayedReport"):
            health_text = f"⚠ 课程页上报延迟{age}秒 | " + health_text
        if snap.get("supervisorMessage"):
            health_text += " | 守护:" + snap["supervisorMessage"][:90]
        self.lbl_health.config(text=health_text[:250], foreground=(
            "#e02424" if page.get("delayedReport") or diag.get("status") in {"stalled", "warning"} else "#6b7280"
        ))
        self._update_tree(page.get("courses") or [])

        effective_running = snap["desiredRunning"]
        if effective_running is None:
            effective_running = page.get("autoEnabled")
        guard_change = self.sleep_guard.update(bool(effective_running))
        if guard_change == "enabled":
            self.log("自动学习期间已阻止 Windows 进入睡眠；显示器仍可自动关闭。")
        elif guard_change == "disabled":
            self.log("已恢复 Windows 原有的睡眠设置。")
        self.btn_normal.config(state="disabled" if effective_running and study_mode == "normal" else "normal")
        self.btn_special.config(state="disabled" if effective_running and study_mode == "special" else "normal")
        self.btn_stop.config(state="normal" if effective_running and study_mode in {"normal", "special"} else "disabled")
        if self.activity_pulse.pulse_if_due(bool(effective_running) and online):
            self.log("实验性键鼠保活已执行：鼠标往返1像素、F15按下抬起（浏览器前台）。")

        signature = (
            online,
            page.get("mode"),
            page.get("message"),
            page.get("courseTitle"),
            page.get("progress"),
            page.get("autoEnabled"),
            page.get("studyMode"),
        )
        if online and signature != self.last_log_signature:
            summary = page.get("message") or page.get("courseTitle") or "网页状态已更新"
            self.log(summary, persist=False)
            self.last_log_signature = signature
        latest = snap.get("latestEvent") or {}
        if latest.get("id") and latest["id"] != self.last_event_id:
            self.last_event_id = latest["id"]
            self.log(f"网页事件[{latest.get('kind')}]: {latest.get('message')}", persist=False)

        self.root.after(1000, self.refresh_status)

    def _update_tree(self, courses: list[dict[str, str]]) -> None:
        old_values = [self.tree.item(item, "values") for item in self.tree.get_children()]
        new_values = [
            (str(index), c.get("title", "未命名课程"), c.get("progress", "--"), c.get("status", ""))
            for index, c in enumerate(courses, start=1)
        ]
        if old_values == new_values:
            return
        for item in self.tree.get_children():
            self.tree.delete(item)
        for values in new_values:
            self.tree.insert("", "end", values=values)

    def start_normal_study(self) -> None:
        self.state.start_mode("normal")
        if self.state.snapshot()["online"]:
            self.log("已选择“普通课程”模式：只学习个人中心课程，不进入网上专题班。")
        else:
            self.log("已选择“普通课程”模式；命令已排队，网页脚本连接后执行。")

    def start_special_study(self) -> None:
        self.state.start_mode("special")
        if self.state.snapshot()["online"]:
            self.log("已选择“网上专题班”模式：只学习专题班，不进入普通课程。")
        else:
            self.log("已选择“网上专题班”模式；命令已排队，网页脚本连接后执行。")

    def stop_study(self) -> None:
        self.state.set_running(False)
        if self.state.snapshot()["online"]:
            self.log("已向油猴脚本发送“暂停当前学习模式”命令。")
        else:
            self.log("油猴脚本尚未连接；暂停命令已排队，网页脚本连接后执行。")

    def manual_refresh(self) -> None:
        if not self.state.snapshot()["online"]:
            self.log("油猴脚本未连接，无法远程刷新；请先在浏览器中按 Ctrl+F5。")
            return
        self.state.request_refresh()
        self.log("已向油猴脚本发送“刷新当前网页”命令。")

    def toggle_activity_pulse(self) -> None:
        enabled = self.activity_pulse_var.get() and self.activity_pulse.supported
        self.activity_pulse.enabled = enabled
        self.activity_pulse.last_pulse = time.monotonic()
        try:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            self.settings_path.write_text(
                json.dumps({"enableInputPulse": enabled}, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            self.log(f"无法保存键鼠实验选项，下次重启需重新选择：{exc}")
        if enabled:
            self.log("已启用实验性键鼠保活：仅浏览器位于前台、系统空闲超过150秒且学习开启，每约4分钟轻微移动鼠标并发送F15；不操作课程控件。")
        else:
            self.log("已关闭实验性键鼠保活。")

    def open_log_directory(self) -> None:
        if not self.logger:
            return
        directory = self.logger.directory
        try:
            directory.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(str(directory))
            elif shutil.which("xdg-open"):
                subprocess.Popen(["xdg-open", str(directory)])
            else:
                self.log(f"日志目录：{directory}")
        except OSError as exc:
            messagebox.showerror("无法打开日志目录", str(exc))

    def open_website(self) -> None:
        candidates = [shutil.which("msedge.exe")]
        for env_name in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env_name)
            if base:
                candidates.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))

        for edge_path in dict.fromkeys(path for path in candidates if path):
            if not os.path.isfile(edge_path):
                continue
            try:
                subprocess.Popen(
                    [edge_path, "--new-tab", SITE_URL],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self.log("已使用 Microsoft Edge 打开个人中心；请确认是安装油猴的浏览器配置。")
                return
            except OSError:
                continue

        if webbrowser.open(SITE_URL):
            self.log("未定位到 Edge，已使用 Windows 默认浏览器打开个人中心。")
        else:
            messagebox.showwarning("未能打开浏览器", f"请手动访问：\n{SITE_URL}")

    def on_close(self) -> None:
        self.activity_pulse.enabled = False
        self.sleep_guard.update(False)
        self.bridge.stop()
        self.root.destroy()


def run_bridge_only() -> None:
    logger = DiagnosticLog()
    state = BridgeState(logger)
    bridge = LocalBridge(state)
    port = bridge.start()
    logger.write(f"桥接服务启动 (bridge-only)，端口={port}，版本={APP_VERSION}")
    print(json.dumps({"ok": True, "host": BRIDGE_HOST, "port": port}, ensure_ascii=False), flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.write("桥接服务关闭")
        bridge.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="青岛干部网络学院学习助手")
    parser.add_argument("--bridge-only", action="store_true", help="仅启动本地桥接服务")
    args = parser.parse_args()
    if args.bridge_only:
        run_bridge_only()
        return

    logger = DiagnosticLog()
    state = BridgeState(logger)
    bridge = LocalBridge(state)
    try:
        bridge.start()
    except OSError as exc:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("启动失败", f"{exc}\n\n请关闭旧版助手或重启电脑后再试。")
        root.destroy()
        return

    root = tk.Tk()
    logger.write(f"桥接服务启动，端口={bridge.port}，版本={APP_VERSION}")
    StudyHelperApp(root, state, bridge)
    root.mainloop()


if __name__ == "__main__":
    main()
