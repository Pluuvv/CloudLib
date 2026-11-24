#!/usr/bin/env python3
"""Send concurrent GETs through ingress and record HPA scale-up/down evidence."""

import argparse
import csv
import http.client
import json
import socket
import subprocess
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


class LoadGenerator:
    def __init__(self, url, concurrency, timeout, host_header=None):
        self.url = urlsplit(url)
        if self.url.scheme not in ("http", "https") or not self.url.hostname:
            raise ValueError("URL must use http:// or https://")
        if self.url.username or self.url.password:
            raise ValueError("Use a public GET endpoint without credentials in the URL")
        self.path = self.url.path or "/"
        if self.url.query:
            self.path += "?" + self.url.query
        self.timeout = timeout
        self.headers = {"Host": host_header} if host_header else {}
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.statuses = Counter()
        self.errors = 0
        self.sockets = set()
        self.threads = [threading.Thread(target=self.worker) for _ in range(concurrency)]

    def connection(self):
        client = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        return client(self.url.hostname, self.url.port, timeout=self.timeout)

    def worker(self):
        connection = self.connection()
        try:
            while not self.stop_event.is_set():
                active_socket = None
                try:
                    connection.request("GET", self.path, headers=self.headers)
                    active_socket = connection.sock
                    with self.lock:
                        self.sockets.add(active_socket)
                    response = connection.getresponse()
                    while response.read1(65536):
                        pass
                    if response.length not in (None, 0):
                        raise http.client.IncompleteRead(b"")
                    with self.lock:
                        self.statuses[str(response.status)] += 1
                except (OSError, http.client.HTTPException):
                    with self.lock:
                        self.errors += 1
                    connection.close()
                    # Avoid spinning at full CPU if ingress is unavailable.
                    self.stop_event.wait(0.05)
                finally:
                    with self.lock:
                        self.sockets.discard(active_socket)
        finally:
            connection.close()

    def start(self):
        for worker in self.threads:
            worker.start()

    def stop(self):
        self.stop_event.set()
        deadline = time.monotonic() + self.timeout
        for worker in self.threads:
            worker.join(max(0, deadline - time.monotonic()))
        # A trickling response may never hit a socket timeout; interrupt its I/O.
        with self.lock:
            sockets = list(self.sockets)
        for active_socket in sockets:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for worker in self.threads:
            worker.join()

    def snapshot(self):
        with self.lock:
            successful = sum(count for status, count in self.statuses.items() if 200 <= int(status) < 300)
            requests = sum(self.statuses.values()) + self.errors
            return {"requests": requests, "successful": successful,
                    "failed": requests - successful, "http_statuses": dict(self.statuses),
                    "connection_errors": self.errors}


def cluster_sample(context, namespace, deployment):
    result = subprocess.run(
        ["kubectl", "--context", context, "--request-timeout=5s", "-n", namespace,
         "get", f"deployment/{deployment}", f"hpa/{deployment}", "-o", "json"],
        capture_output=True, text=True, timeout=15, check=True,
    )
    objects = {item["kind"]: item for item in json.loads(result.stdout)["items"]}
    app, hpa = objects["Deployment"], objects["HorizontalPodAutoscaler"]
    cpu = next((metric["resource"]["current"].get("averageUtilization")
                for metric in hpa.get("status", {}).get("currentMetrics", [])
                if metric.get("resource", {}).get("name") == "cpu"), None)
    active = any(condition["type"] == "ScalingActive" and condition["status"] == "True"
                 for condition in hpa.get("status", {}).get("conditions", []))
    target = hpa["spec"]["scaleTargetRef"]
    if target.get("kind") != "Deployment" or target.get("name") != deployment:
        raise ValueError("HPA does not target the requested Deployment")
    return {"desired": app["spec"]["replicas"], "ready": app.get("status", {}).get("readyReplicas", 0),
            "hpa_desired": hpa.get("status", {}).get("desiredReplicas", 0),
            "cpu_percent": cpu, "active": active,
            "minimum": hpa["spec"].get("minReplicas", 1), "maximum": hpa["spec"]["maxReplicas"]}


def scaling_verdict(samples, baseline, minimum):
    scaled_up = scaled_down = False
    for sample in samples:
        if sample["ready"] > baseline and sample["desired"] > baseline and sample["hpa_desired"] > baseline:
            scaled_up = True
        if (scaled_up and sample["phase"] == "cooldown"
                and sample["ready"] == sample["desired"] == minimum):
            scaled_down = True
    return {"scale_up_observed": scaled_up, "scale_down_observed": scaled_down}


def positive(value):
    number = float(value)
    if not 0 < number < float("inf"):
        raise argparse.ArgumentTypeError("must be a finite number greater than zero")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8088/hello")
    parser.add_argument("--host-header", default="cloudlib.localhost", help="ingress Host header; empty uses the URL host")
    parser.add_argument("--concurrency", type=int, choices=range(1, 513), default=32, metavar="1..512")
    parser.add_argument("--duration", type=positive, default=300, help="load duration in seconds (default: 300)")
    parser.add_argument("--cooldown", type=int, default=420, help="idle observation seconds; 0 skips downscale check")
    parser.add_argument("--timeout", type=positive, default=5, help="HTTP socket timeout in seconds")
    parser.add_argument("--sample-interval", type=positive, default=5)
    parser.add_argument("--context", default="k3d-capstone")
    parser.add_argument("--namespace", default="capstone")
    parser.add_argument("--deployment", default="cloudlib-app", help="Deployment and HPA name")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.cooldown < 0:
        parser.error("--cooldown must be zero or greater")

    load = LoadGenerator(args.url, args.concurrency, args.timeout, args.host_header)
    initial = cluster_sample(args.context, args.namespace, args.deployment)
    if not initial["active"] or initial["cpu_percent"] is None:
        raise ValueError("HPA CPU metrics are unavailable; check metrics-server and wait for HPA ScalingActive=True")
    if initial["ready"] != initial["minimum"] or initial["desired"] != initial["minimum"]:
        raise ValueError("Wait for idle baseline: Deployment desired and ready replicas must equal HPA minReplicas")
    connection = load.connection()
    try:
        connection.request("GET", load.path, headers=load.headers)
        with connection.getresponse() as response:
            if not 200 <= response.status < 300:
                raise ValueError(f"Preflight HTTP {response.status}; choose a public GET endpoint returning 2xx")
    finally:
        connection.close()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = args.output_dir or Path(__file__).resolve().parent / ".runtime/autoscaling" / stamp
    output.mkdir(parents=True, exist_ok=True)
    samples = []
    interrupted = False
    observation_error = None
    load_seconds = 0
    started = time.monotonic()
    fields = ["timestamp", "phase", "requests", "successful", "failed", "cpu_percent", "desired", "ready", "hpa_desired"]
    print(f"Target: {args.url} | {args.concurrency} concurrent workers | evidence: {output}", flush=True)

    with (output / "samples.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()

        def record(phase, state=None):
            state = state if state is not None else cluster_sample(args.context, args.namespace, args.deployment)
            sample = {**state, **load.snapshot(), "phase": phase,
                      "timestamp": datetime.now(timezone.utc).isoformat()}
            samples.append(sample)
            writer.writerow(sample)
            stream.flush()
            print(f"{phase:8} CPU={state['cpu_percent']}% desired={state['desired']} ready={state['ready']} "
                  f"requests={sample['requests']} failed={sample['failed']}", flush=True)

        def observe(phase, seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                time.sleep(min(args.sample_interval, max(0, deadline - time.monotonic())))
                record(phase)

        record("baseline", initial)
        load.start()
        try:
            try:
                observe("load", args.duration)
            finally:
                load.stop()
                load_seconds = time.monotonic() - started
            print("Load stopped; observing cooldown.", flush=True)
            observe("cooldown", args.cooldown)
        except KeyboardInterrupt:
            interrupted = True
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            observation_error = str(error)

    summary = {**load.snapshot(), **scaling_verdict(samples, initial["ready"], initial["minimum"]),
               "url": args.url, "host_header": args.host_header,
               "context": args.context, "namespace": args.namespace,
               "deployment": args.deployment, "concurrency": args.concurrency,
               "load_seconds": round(load_seconds, 2), "cooldown_seconds": args.cooldown,
               "baseline_ready": initial["ready"], "max_ready": max(sample["ready"] for sample in samples),
               "max_desired": max(sample["desired"] for sample in samples),
               "interrupted": interrupted, "observation_error": observation_error}
    summary["requests_per_second"] = round(summary["requests"] / max(load_seconds, 0.001), 2)
    summary["passed"] = (not interrupted and observation_error is None and summary["requests"] > 0
                         and summary["failed"] == 0 and summary["scale_up_observed"]
                         and (args.cooldown == 0 or summary["scale_down_observed"]))
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)
    if not summary["scale_up_observed"]:
        print("No ready-pod scale-up observed. Check CPU samples, HPA events, pending pods; try more concurrency or duration.")
    if args.cooldown and not summary["scale_down_observed"]:
        print("No return to minReplicas observed. Check idle CPU and allow more cooldown time.")
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, http.client.HTTPException, subprocess.SubprocessError) as error:
        raise SystemExit(f"Autoscaling test failed: {error}")
