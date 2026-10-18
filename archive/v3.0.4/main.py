#!/usr/bin/env python3
"""青岛干部网络学院学习助手桌面端。

桌面端只在本机 127.0.0.1 上启动一个轻量桥接服务。油猴脚本负责读取网页、
执行页面操作并定时上报状态，因此不再依赖 AgentLimb 或 requests 第三方包。
"""

from __future__ import annotations

import argparse
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
from urllib.parse import urlparse


APP_VERSION = "3.0.4"
SITE_URL = "https://www.qdgbjy.gov.cn/person"
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORTS = (7791, 17791)
MAX_BODY_BYTES = 1024 * 1024


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


class BridgeState:
    """线程安全地保存网页端上报状态和桌面端控制命令。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
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
            "courses": [],
        }
        self._desired_running: bool | None = None
        self._command_revision = 0
        self._refresh_revision = 0

    @staticmethod
    def _clean_text(value: Any, limit: int) -> str:
        if value is None:
            return ""
        return str(value).replace("\x00", "").strip()[:limit]

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
            "courseTitle": self._clean_text(payload.get("courseTitle"), 300),
            "progress": self._clean_text(payload.get("progress"), 30),
            "message": self._clean_text(payload.get("message"), 500),
            "autoEnabled": payload.get("autoEnabled")
            if isinstance(payload.get("autoEnabled"), bool)
            else None,
            "courses": courses,
        }
        with self._lock:
            self._page = page
            self._last_seen = time.time()

    def set_running(self, enabled: bool) -> None:
        with self._lock:
            self._desired_running = bool(enabled)
            self._command_revision += 1

    def request_refresh(self) -> None:
        with self._lock:
            self._refresh_revision += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            age = time.time() - self._last_seen if self._last_seen else None
            return {
                "ok": True,
                "appVersion": APP_VERSION,
                "online": age is not None and age < 8,
                "lastSeenSeconds": round(age, 1) if age is not None else None,
                "desiredRunning": self._desired_running,
                "commandRevision": self._command_revision,
                "refreshRevision": self._refresh_revision,
                "page": dict(self._page),
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
            self._send_json(200, state.snapshot())

    return BridgeHandler


class LocalBridge:
    def __init__(self, state: BridgeState) -> None:
        self.state = state
        self.server: ReusableThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.port: int | None = None

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
        return self.port

    def stop(self) -> None:
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
        self.last_log_signature: tuple[Any, ...] | None = None

        self.root.title("青岛干部网络学院 - 自动化学习助手")
        self.root.geometry("860x680")
        self.root.minsize(780, 580)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self._setup_style()
        self._build_ui()
        self.log("桌面端已启动，等待网页中的油猴脚本连接。")
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

        btn_frame = ttk.Frame(self.root, padding=6)
        btn_frame.pack(fill="x", padx=12)
        self.btn_start = ttk.Button(
            btn_frame,
            text="▶ 开始自动学习",
            style="Accent.TButton",
            command=self.start_study,
        )
        self.btn_start.pack(side="left", padx=5)
        self.btn_stop = ttk.Button(btn_frame, text="⏹ 停止学习", command=self.stop_study)
        self.btn_stop.pack(side="left", padx=5)
        self.btn_refresh = ttk.Button(btn_frame, text="🔄 刷新当前网页", command=self.manual_refresh)
        self.btn_refresh.pack(side="left", padx=5)
        self.btn_open_edge = ttk.Button(btn_frame, text="🌐 用 Edge 打开个人中心", command=self.open_website)
        self.btn_open_edge.pack(side="right", padx=5)

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

    def log(self, message: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {message}\n"
        self.log_text.insert("end", line)
        self.log_text.see("end")

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
            "other": "网站其他页面",
            "unknown": "暂无",
        }.get(page.get("mode"), page.get("mode") or "暂无")
        self.lbl_page.config(text=f"当前页面: {page_label}")

        title = page.get("courseTitle") or page.get("message") or "当前未在学习任何课程"
        self.lbl_curr_title.config(text=title)
        progress = page.get("progress") or "0%"
        self.progress_bar.config(value=self._progress_number(progress))
        self.lbl_percent.config(text=progress)
        self._update_tree(page.get("courses") or [])

        effective_running = snap["desiredRunning"]
        if effective_running is None:
            effective_running = page.get("autoEnabled")
        guard_change = self.sleep_guard.update(bool(effective_running))
        if guard_change == "enabled":
            self.log("自动学习期间已阻止 Windows 进入睡眠；显示器仍可自动关闭。")
        elif guard_change == "disabled":
            self.log("已恢复 Windows 原有的睡眠设置。")
        self.btn_start.config(state="disabled" if effective_running else "normal")
        self.btn_stop.config(state="normal" if effective_running else "disabled")

        signature = (
            online,
            page.get("mode"),
            page.get("message"),
            page.get("courseTitle"),
            page.get("progress"),
            page.get("autoEnabled"),
        )
        if online and signature != self.last_log_signature:
            summary = page.get("message") or page.get("courseTitle") or "网页状态已更新"
            self.log(summary)
            self.last_log_signature = signature

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

    def start_study(self) -> None:
        self.state.set_running(True)
        if self.state.snapshot()["online"]:
            self.log("已向油猴脚本发送“开始自动学习”命令。")
        else:
            self.log("油猴脚本尚未连接；开始命令已排队，网页脚本连接后执行。")

    def stop_study(self) -> None:
        self.state.set_running(False)
        if self.state.snapshot()["online"]:
            self.log("已向油猴脚本发送“停止学习”命令。")
        else:
            self.log("油猴脚本尚未连接；停止命令已排队，网页脚本连接后执行。")

    def manual_refresh(self) -> None:
        if not self.state.snapshot()["online"]:
            self.log("油猴脚本未连接，无法远程刷新；请先在浏览器中按 Ctrl+F5。")
            return
        self.state.request_refresh()
        self.log("已向油猴脚本发送“刷新当前网页”命令。")

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
        self.sleep_guard.update(False)
        self.bridge.stop()
        self.root.destroy()


def run_bridge_only() -> None:
    state = BridgeState()
    bridge = LocalBridge(state)
    port = bridge.start()
    print(json.dumps({"ok": True, "host": BRIDGE_HOST, "port": port}, ensure_ascii=False), flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        bridge.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="青岛干部网络学院学习助手")
    parser.add_argument("--bridge-only", action="store_true", help="仅启动本地桥接服务")
    args = parser.parse_args()
    if args.bridge_only:
        run_bridge_only()
        return

    state = BridgeState()
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
    StudyHelperApp(root, state, bridge)
    root.mainloop()


if __name__ == "__main__":
    main()
