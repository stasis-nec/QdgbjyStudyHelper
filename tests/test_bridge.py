"""离线测试：日志写入、事件去重、报告校验和本机HTTP桥接。"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from main import APP_VERSION, BridgeState, DiagnosticLog, ReusableThreadingHTTPServer, make_handler


class BridgeTests(unittest.TestCase):
    def test_daily_file_and_event_deduplication(self):
        with tempfile.TemporaryDirectory() as tempdir:
            log = DiagnosticLog(Path(tempdir) / "日志")
            state = BridgeState(log)
            report = {
                "studyMode": "special", "mode": "detail", "courseTitle": "第一课第二节",
                "progress": "65%", "message": "进度维持65%",
                "diagnostics": {"status": "warning", "videoTime": "391.0", "videoDuration": "600.0", "section": "第二节"},
                "events": [{"id": "abc-1", "kind": "warning", "course": "第一课第二节", "message": "停滞120秒"}],
            }
            state.report(report)
            state.report(report)
            paths = list((Path(tempdir) / "日志").glob("study_*.log"))
            self.assertEqual(1, len(paths))
            content = paths[0].read_text(encoding="utf-8")
            self.assertEqual(content.count("停滞120秒"), 1)
            self.assertIn("65%", content)
            self.assertEqual(state.snapshot()["latestEvent"]["id"], "abc-1")
            self.assertEqual(state.snapshot()["page"]["diagnostics"]["videoTime"], "391.0")
            self.assertEqual(APP_VERSION, "3.3.5")

    def test_parallel_tabs_no_state_oscillation(self):
        state = BridgeState()
        detail = {
            "tabId": "play-1", "studyMode": "special", "mode": "detail",
            "courseTitle": "行政诉讼庭审视频1（下）", "progress": "75%",
            "progressSource": "sections-average", "siteProgress": "99%",
        }
        listing = {
            "tabId": "list-1", "studyMode": "special", "mode": "special-class",
            "courseTitle": "网上专题班", "progress": "",
            "courses": [{"title": "行政诉讼案件庭审视频1", "progress": "75%"}],
        }
        state.report(detail)
        state.report(listing)
        self.assertEqual(state.snapshot()["page"]["mode"], "detail")
        self.assertEqual(state.snapshot()["page"]["progress"], "75%")
        self.assertEqual(state.snapshot()["page"]["progressSource"], "sections-average")
        self.assertEqual(state.snapshot()["page"]["siteProgress"], "99%")

    def test_per_tab_transition_does_not_log_every_poll(self):
        with tempfile.TemporaryDirectory() as d:
            logger = DiagnosticLog(Path(d))
            state = BridgeState(logger)
            for _ in range(12):
                state.report({"tabId": "detail", "mode": "detail", "studyMode": "special",
                              "courseTitle": "课程2", "progress": "50%"})
                state.report({"tabId": "list", "mode": "special-class", "studyMode": "special",
                              "courseTitle": "专题班"})
            content = next(Path(d).glob("*.log")).read_text(encoding="utf-8")
            self.assertEqual(content.count("网页状态切换"), 2)

    def test_input_pulse_opt_in_no_linux_injection(self):
        from main import ForegroundActivityPulse
        guard = ForegroundActivityPulse()
        self.assertFalse(guard.enabled)
        self.assertFalse(guard.pulse_if_due(True))

    def test_activity_pulse_only_when_opted_in_and_idle(self):
        from unittest.mock import patch
        from main import ForegroundActivityPulse
        guard = ForegroundActivityPulse()
        guard.supported = True
        guard.enabled = True
        guard.last_pulse -= 1000
        class FakeUser32:
            def __init__(self): self.calls = []
            def mouse_event(self, *args): self.calls.append(("mouse", args))
            def keybd_event(self, *args): self.calls.append(("key", args))
        fake = FakeUser32()
        with patch.object(ForegroundActivityPulse, "_active_browser", return_value=True), \
             patch.object(ForegroundActivityPulse, "_idle_seconds", return_value=300), \
             patch("main.ctypes.windll", create=True) as dll:
            dll.user32 = fake
            self.assertFalse(guard.pulse_if_due(False))
            self.assertTrue(guard.pulse_if_due(True))
            self.assertFalse(guard.pulse_if_due(True))
            self.assertEqual([kind for kind, _args in fake.calls],
                             ["mouse", "mouse", "key", "key"])
        guard.last_pulse -= 1000
        with patch.object(ForegroundActivityPulse, "_active_browser", return_value=False):
            self.assertFalse(guard.pulse_if_due(True))

    def test_desktop_watchdog_asks_only_matching_list_for_recovery(self):
        from unittest.mock import patch
        import main
        fake_clock = [10000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: fake_clock[0]):
            state.start_mode("special")
            detail = {"tabId": "player-1", "studyMode": "special", "mode": "detail",
                      "courseTitle": "第二节", "courseKey": "课程A", "classId": "class-1",
                      "autoEnabled": True, "progress": "65%",
                      "diagnostics": {"status": "playing", "videoTime": "480", "videoDuration": "3600", "section": "第二节"}}
            listing = {"tabId": "class-tab", "studyMode": "special", "mode": "special-class",
                       "classId": "class-1", "courseTitle": "专题班", "autoEnabled": True}
            state.report(detail)
            state.report(listing)
            fake_clock[0] += 190
            state.report(listing)
            state.check_course_watchdog()
            info = state.snapshot(recipient_tab="class-tab")
            req = info["recoveryRequest"]
            self.assertEqual(req["tabId"], "player-1")
            self.assertEqual(req["courseKey"], "课程A")
            self.assertIsNone(state.snapshot(recipient_tab="player-1")["recoveryRequest"])
            self.assertTrue(info["guardianAvailable"])
            state.report({**listing, "recoveryAck": {"id": req["id"], "status": "closed"}})
            self.assertIsNone(state.snapshot(recipient_tab="class-tab")["recoveryRequest"])
            self.assertIsNone(state._watch_target)
            self.assertEqual(1, len(state._recovery_counts["class-1|课程A"]))

    def test_delayed_ack_keeps_running_and_resumes_after_list_thaws(self):
        from unittest.mock import patch
        import main
        clock = [40000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: clock[0]):
            state.start_mode("special")
            state.report({"tabId": "player", "mode": "detail", "studyMode": "special",
                "classId": "c", "courseKey": "A", "progress": "65%", "autoEnabled": True,
                "diagnostics": {"status": "playing", "videoTime": "0",
                                "videoDuration": "3600", "section": "下"}})
            clock[0] += 190
            state.report({"tabId": "list", "mode": "special-class", "studyMode": "special",
                          "classId": "c", "autoEnabled": True})
            state.check_course_watchdog()
            self.assertIsNotNone(state.snapshot(recipient_tab="list")["recoveryRequest"])
            clock[0] += 46
            state.check_course_watchdog()
            self.assertIsNotNone(state.snapshot(recipient_tab="list")["recoveryRequest"])
            self.assertTrue(state.snapshot()["desiredRunning"])
            self.assertIn("等待回应", state.snapshot()["supervisorMessage"])
            # Reproduce an 81-minute browser freeze, followed by the delayed ACK.
            clock[0] += 81 * 60
            state.check_course_watchdog()
            state.report({"tabId": "list", "mode": "special-class", "studyMode": "special",
                          "classId": "c", "autoEnabled": True,
                          "recoveryAck": {"id": state._pending_recovery["id"], "status": "closed"}})
            self.assertIsNone(state.snapshot(recipient_tab="list")["recoveryRequest"])
            self.assertTrue(state.snapshot()["desiredRunning"])
            self.assertEqual(1, len(state._recovery_counts["c|A"]))

    def test_pending_request_canceled_if_video_resumes(self):
        from unittest.mock import patch
        import main
        clock = [50000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: clock[0]):
            state.start_mode("special")
            detail = {"tabId": "player", "mode": "detail", "studyMode": "special",
                "classId": "c", "courseKey": "A", "progress": "65%", "autoEnabled": True,
                "diagnostics": {"status": "playing", "videoTime": "100",
                                "videoDuration": "3600", "section": "下"}}
            listing = {"tabId": "list", "mode": "special-class", "studyMode": "special",
                "classId": "c", "autoEnabled": True}
            state.report(detail)
            clock[0] += 190
            state.report(listing)
            state.check_course_watchdog()
            self.assertIsNotNone(state._pending_recovery)
            clock[0] += 5
            detail["diagnostics"]["videoTime"] = "120"
            state.report(detail)
            self.assertIsNone(state._pending_recovery)
            self.assertTrue(state.snapshot()["desiredRunning"])

    def test_manual_pause_cancels_pending_recovery(self):
        from unittest.mock import patch
        import main
        clock = [60000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: clock[0]):
            state.start_mode("special")
            state.report({"tabId": "player", "mode": "detail", "studyMode": "special",
                "classId": "c", "courseKey": "A", "progress": "65%", "autoEnabled": True,
                "diagnostics": {"status": "playing", "videoTime": "100",
                                "videoDuration": "3600", "section": "下"}})
            clock[0] += 190
            state.report({"tabId": "list", "mode": "special-class", "studyMode": "special",
                "classId": "c", "autoEnabled": True})
            state.check_course_watchdog()
            self.assertIsNotNone(state._pending_recovery)
            state.set_running(False)
            self.assertIsNone(state._pending_recovery)
            self.assertFalse(state.snapshot()["desiredRunning"])

    def test_browser_pause_cancels_queued_close(self):
        from unittest.mock import patch
        import main
        clock = [65000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: clock[0]):
            state.start_mode("special")
            detail = {"tabId": "player", "mode": "detail", "studyMode": "special",
                "classId": "c", "courseKey": "A", "progress": "65%", "autoEnabled": True,
                "diagnostics": {"status": "playing", "videoTime": "100",
                                "videoDuration": "3600", "section": "下"}}
            listing = {"tabId": "list", "mode": "special-class", "studyMode": "special",
                "classId": "c", "autoEnabled": True}
            state.report(detail)
            clock[0] += 190
            state.report(listing)
            state.check_course_watchdog()
            self.assertIsNotNone(state._pending_recovery)
            state.report({**listing, "autoEnabled": False})
            self.assertIsNone(state._pending_recovery)

    def test_video_clock_continues_so_no_false_recovery(self):
        from unittest.mock import patch
        import main
        clock = [20000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: clock[0]):
            state.start_mode("special")
            detail = {"tabId": "p", "mode": "detail", "studyMode": "special",
                      "classId": "c", "courseKey": "A", "courseTitle": "A", "progress": "65%",
                      "diagnostics": {"status": "playing", "videoTime": "0", "videoDuration": "3600", "section": "1"}}
            lst = {"tabId": "l", "mode": "special-class", "classId": "c", "studyMode": "special"}
            state.report(detail)
            for n in range(1, 7):
                clock[0] += 60
                detail["diagnostics"]["videoTime"] = str(n * 60)
                state.report(detail)
                state.report(lst)
                state.check_course_watchdog()
                self.assertIsNone(state.snapshot(recipient_tab="l")["recoveryRequest"])

    def test_different_class_or_paused_course_does_not_recover(self):
        from unittest.mock import patch
        import main
        clock = [30000.0]
        state = BridgeState()
        with patch.object(main.time, "time", side_effect=lambda: clock[0]):
            state.start_mode("special")
            d = {"tabId": "p", "studyMode": "special", "mode": "detail", "classId": "c1",
                 "courseKey": "A", "progress": "40%",
                 "diagnostics": {"status": "paused", "videoTime": "5", "videoDuration": "3600", "section": "1"}}
            l = {"tabId": "l", "studyMode": "special", "mode": "special-class", "classId": "c2"}
            state.report(d)
            clock[0] += 600
            state.report(l)
            state.check_course_watchdog()
            self.assertIsNone(state.snapshot(recipient_tab="l")["recoveryRequest"])
            d["diagnostics"]["status"] = "playing"
            state.report(d)
            clock[0] += 200
            state.report(l)
            state.check_course_watchdog()
            self.assertIsNone(state.snapshot(recipient_tab="l")["recoveryRequest"])

    def test_http_bridge(self):
        state = BridgeState()
        server = ReusableThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            conn.request("POST", "/api/report", body=json.dumps({"studyMode": "normal", "progress": "65%"}),
                         headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            data = json.loads(resp.read())
            self.assertEqual(resp.status, 200)
            self.assertTrue(data["online"])
            self.assertEqual(data["page"]["progress"], "65%")
            conn.request("GET", "/api/status")
            self.assertEqual(conn.getresponse().status, 200)
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()


class AccountSwitchTests(unittest.TestCase):
    def test_new_account_replaces_old_video_state(self):
        state = BridgeState()
        state.start_mode('special')
        state.report({'tabId': 'old-play', 'accountKey':'A', 'mode':'detail',
                      'studyMode':'special','courseTitle':'旧账号课程',
                      'autoEnabled':True, 'progress':'50%'})
        state.report({'tabId':'new-list', 'accountKey':'B', 'mode':'special-class',
                      'studyMode':'special','courseTitle':'新账号班级',
                      'autoEnabled':True})
        self.assertEqual(state.snapshot()['page']['courseTitle'], '新账号班级')
        # Late old-account video reports cannot bring the old status back.
        state.report({'tabId': 'old-play', 'accountKey':'A', 'mode':'detail',
                      'studyMode':'special','courseTitle':'旧账号课程',
                      'autoEnabled':True, 'progress':'51%'})
        self.assertEqual(state.snapshot()['page']['courseTitle'], '新账号班级')
        self.assertEqual(state.snapshot()['desiredRunning'], True)

    def test_course_list_prioritized_over_general_class_entrance(self):
        state=BridgeState()
        state.report({'tabId':'class','accountKey':'A','mode':'special-class',
                     'studyMode':'special','courseTitle':'班级中的课程列表'})
        state.report({'tabId':'entrance','accountKey':'A','mode':'special-list',
                     'studyMode':'special','courseTitle':'全部班级列表'})
        self.assertEqual(state.snapshot()['page']['mode'], 'special-class')

    def test_login_screen_releases_prior_user_context(self):
        state = BridgeState()
        state.report({'tabId':'player','accountKey':'A','mode':'detail',
                      'studyMode':'special','courseTitle':'A课程'})
        state.report({'tabId':'login','accountKey':'','mode':'login','studyMode':'special'})
        self.assertEqual(state.snapshot()['page']['mode'], 'login')
        state.report({'tabId':'new','accountKey':'B','mode':'person','studyMode':'special'})
        self.assertEqual(state.snapshot()['page']['mode'], 'person')
        state.report({'tabId':'player','accountKey':'A','mode':'detail','studyMode':'special',
                      'courseTitle':'A课程'})
        self.assertEqual(state.snapshot()['page']['mode'], 'person')
