#!/usr/bin/env python3
"""Pull green Gleb_test commits into the staging-only runtime."""

import fcntl
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CONFIG = Path("/etc/coherent-staging")
REPO = "gerrire/Coherent"
BRANCH = "Gleb_test"
API = f"https://api.github.com/repos/{REPO}"
SHA = re.compile(r"[a-f0-9]{40}")


def github(path):
    request = Request(
        API + path,
        headers={"User-Agent": "Coherent-staging", "Accept": "application/vnd.github+json"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def deploy():
    if (CONFIG / "auto-paused").exists():
        return
    current = (CONFIG / "deployed-sha").read_text().strip()
    target = github(f"/branches/{BRANCH}")["commit"]["sha"]
    if not SHA.fullmatch(current) or not SHA.fullmatch(target):
        raise ValueError("Invalid staging revision")
    if target == current:
        return
    failed = CONFIG / "auto-failed-sha"
    if failed.exists() and failed.read_text().strip() == target and time.time() - failed.stat().st_mtime < 1800:
        print(f"{target[:12]} is in the deployment retry cooldown", flush=True)
        return
    query = urlencode({"branch": BRANCH, "head_sha": target, "event": "push", "per_page": 10})
    runs = github("/actions/workflows/build-deploy.yml/runs?" + query)["workflow_runs"]
    if not any(
        run["head_sha"] == target and run["head_branch"] == BRANCH
        and run["event"] == "push" and run["conclusion"] == "success"
        for run in runs
    ):
        print(f"{target[:12]} is waiting for successful CI", flush=True)
        return

    print(f"Deploying green {BRANCH} revision {target[:12]}", flush=True)
    command = ["/usr/local/sbin/coherent-staging", "deploy-head", target]
    try:
        subprocess.run(command, check=True, timeout=1800)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        failed.write_text(target + "\n")
        raise
    failed.unlink(missing_ok=True)


if __name__ == "__main__":
    with Path("/run/lock/coherent-staging-auto.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deploy()
