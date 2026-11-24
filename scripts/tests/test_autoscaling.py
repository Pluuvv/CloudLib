import importlib.util
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "test-autoscaling.py"
spec = importlib.util.spec_from_file_location("autoscaling", SCRIPT)
autoscaling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autoscaling)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    active = 0
    peak = 0
    lock = threading.Lock()

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError):
            # Timeout tests deliberately close persistent connections mid-response.
            pass

    def do_GET(self):
        with self.lock:
            Handler.active += 1
            Handler.peak = max(Handler.peak, Handler.active)
        try:
            time.sleep(0.15 if self.path == "/slow" else 0.01)
            status = 503 if self.path == "/failure" else 200
            if self.path == "/virtual-host" and self.headers.get("Host") != "cloudlib.localhost":
                status = 404
            self.send_response(status)
            length = 100 if self.path in ("/truncated", "/trickle") else 2
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if self.path == "/trickle":
                for _ in range(100):
                    self.wfile.write(b"x")
                    self.wfile.flush()
                    time.sleep(0.01)
                return
            if self.path == "/truncated":
                self.close_connection = True
            self.wfile.write(b"ok")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with self.lock:
                Handler.active -= 1

    def log_message(self, *args):
        pass


class LoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def exercise(self, path, timeout=1):
        load = autoscaling.LoadGenerator(self.url + path, concurrency=4, timeout=timeout)
        load.start()
        try:
            time.sleep(0.25)
        finally:
            load.stop()
        snapshot = load.snapshot()
        self.assertGreater(snapshot["requests"], 0)
        self.assertEqual(snapshot["requests"], snapshot["successful"] + snapshot["failed"])
        # Completed tests must not leave requests running or counters changing.
        time.sleep(0.05)
        self.assertEqual(snapshot, load.snapshot())
        self.assertFalse(any(worker.is_alive() for worker in load.threads))
        return snapshot

    def test_sends_concurrent_successful_gets_and_stops(self):
        Handler.peak = 0
        result = self.exercise("/ok")
        self.assertGreater(Handler.peak, 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["http_statuses"], {"200": result["requests"]})

    def test_non_2xx_responses_are_failures(self):
        result = self.exercise("/failure")
        self.assertEqual(result["successful"], 0)
        self.assertEqual(result["http_statuses"], {"503": result["requests"]})

    def test_routes_loopback_requests_with_ingress_host_header(self):
        load = autoscaling.LoadGenerator(self.url + "/virtual-host", concurrency=2,
                                         timeout=1, host_header="cloudlib.localhost")
        load.start()
        try:
            time.sleep(0.15)
        finally:
            load.stop()
        self.assertGreater(load.snapshot()["successful"], 0)
        self.assertEqual(load.snapshot()["failed"], 0)

    def test_timeouts_are_failures(self):
        result = self.exercise("/slow", timeout=0.03)
        self.assertEqual(result["successful"], 0)
        self.assertEqual(result["failed"], result["connection_errors"])

    def test_truncated_success_response_is_a_failure(self):
        result = self.exercise("/truncated")
        self.assertEqual(result["successful"], 0)
        self.assertEqual(result["failed"], result["requests"])

    def test_stops_a_response_that_never_hits_socket_timeout(self):
        load = autoscaling.LoadGenerator(self.url + "/trickle", concurrency=1, timeout=0.1)
        load.start()
        time.sleep(0.08)
        started = time.monotonic()
        load.stop()
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertFalse(any(worker.is_alive() for worker in load.threads))
        self.assertEqual(load.snapshot()["successful"], 0)

    def test_refused_connections_are_failures(self):
        unused = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        url = f"http://127.0.0.1:{unused.server_port}/"
        unused.server_close()
        load = autoscaling.LoadGenerator(url, concurrency=1, timeout=0.1)
        load.start()
        try:
            time.sleep(0.15)
        finally:
            load.stop()
        result = load.snapshot()
        self.assertGreater(result["connection_errors"], 0)
        self.assertEqual(result["successful"], 0)


class VerdictTests(unittest.TestCase):
    def test_desired_replica_increase_without_ready_pods_is_not_success(self):
        result = autoscaling.scaling_verdict([
            {"phase": "load", "desired": 5, "ready": 1, "hpa_desired": 5},
            {"phase": "cooldown", "desired": 1, "ready": 1, "hpa_desired": 1},
        ], baseline=1, minimum=1)
        self.assertFalse(result["scale_up_observed"])
        self.assertFalse(result["scale_down_observed"])

    def test_downscale_requires_return_to_minimum_after_scale_up(self):
        result = autoscaling.scaling_verdict([
            {"phase": "load", "desired": 4, "ready": 3, "hpa_desired": 4},
            {"phase": "cooldown", "desired": 2, "ready": 2, "hpa_desired": 2},
        ], baseline=1, minimum=1)
        self.assertTrue(result["scale_up_observed"])
        self.assertFalse(result["scale_down_observed"])

    def test_observes_ready_scale_up_then_idle_scale_down(self):
        result = autoscaling.scaling_verdict([
            {"phase": "baseline", "desired": 1, "ready": 1, "hpa_desired": 1},
            {"phase": "load", "desired": 3, "ready": 3, "hpa_desired": 3},
            {"phase": "cooldown", "desired": 1, "ready": 1, "hpa_desired": 1},
        ], baseline=1, minimum=1)
        self.assertTrue(result["scale_up_observed"])
        self.assertTrue(result["scale_down_observed"])

    def test_rollout_surge_is_not_hpa_scale_up(self):
        result = autoscaling.scaling_verdict([
            {"phase": "load", "desired": 1, "ready": 2, "hpa_desired": 1},
            {"phase": "cooldown", "desired": 1, "ready": 1, "hpa_desired": 1},
        ], baseline=1, minimum=1)
        self.assertFalse(result["scale_up_observed"])
        self.assertFalse(result["scale_down_observed"])


if __name__ == "__main__":
    unittest.main()
