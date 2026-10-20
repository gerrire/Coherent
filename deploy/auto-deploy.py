#!/usr/bin/env python3
"""Deploy the latest main commit after its GitHub Actions build succeeds."""

import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path("/opt/coherent")
STATE = Path("/var/lib/coherent-deploy/deployed-sha")
LOCK = Path("/run/lock/coherent-deploy.lock")
WORKFLOW_URL = (
    "https://api.github.com/repos/gerrire/Coherent/actions/"
    "workflows/build-deploy.yml/runs"
)
COMPOSE = [
    "docker", "compose", "--env-file", "deploy/.env", "-f", "deploy/compose.prod.yaml"
]
GIT_ENV = dict(os.environ, GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10")


def run(*args: str, timeout: int = 1800, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args, cwd=ROOT, env=env, check=False, text=True, timeout=timeout,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.stdout.strip():
        print(result.stdout.strip(), flush=True)
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result.stdout.strip()


def git(*args: str) -> str:
    return run("git", *args, timeout=120, env=GIT_ENV)


def successful_build(sha: str) -> bool:
    query = urlencode({"branch": "main", "event": "push", "head_sha": sha, "per_page": 1})
    request = Request(
        f"{WORKFLOW_URL}?{query}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "coherent-vps-deploy"},
    )
    with urlopen(request, timeout=15) as response:
        runs = json.load(response).get("workflow_runs", [])
    if not runs:
        print(f"Build for {sha[:12]} has not appeared yet", flush=True)
        return False
    latest = runs[0]
    if latest.get("head_sha") != sha or latest.get("head_branch") != "main":
        raise RuntimeError("GitHub returned a build for a different commit")
    status = latest.get("status")
    conclusion = latest.get("conclusion")
    print(f"GitHub build for {sha[:12]}: {status}/{conclusion}", flush=True)
    return status == "completed" and conclusion == "success"


def healthy() -> None:
    for attempt in range(12):
        try:
            for url in (
                "https://31.76.77.197/",
                "https://31.76.77.197/api/v1/health/ready",
                "https://31.76.77.197:8443/",
            ):
                with urlopen(url, timeout=10) as response:
                    if response.status != 200:
                        raise RuntimeError(f"{url} returned {response.status}")
            return
        except Exception:
            if attempt == 11:
                raise
            time.sleep(5)


def main() -> None:
    with LOCK.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another deployment is running", flush=True)
            return

        if not STATE.is_file():
            raise RuntimeError(f"Missing deployment state: {STATE}")
        deployed = STATE.read_text().strip()
        if not re.fullmatch(r"[0-9a-f]{40}", deployed):
            raise RuntimeError("Invalid deployment state")

        git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main")
        target = git("rev-parse", "refs/remotes/origin/main")
        if target == deployed:
            return

        if not successful_build(target):
            return
        if git("status", "--porcelain", "--untracked-files=no"):
            raise RuntimeError("Tracked files on the VPS have local changes")
        current = git("rev-parse", "HEAD")
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", current, target],
            cwd=ROOT, env=GIT_ENV, check=True, timeout=120,
        )
        git("merge", "--ff-only", target)
        run(*COMPOSE, "build", "api", "web")
        run(*COMPOSE, "run", "--rm", "api", "alembic", "upgrade", "head")
        run(*COMPOSE, "up", "-d", "--no-build")
        healthy()
        STATE.write_text(target + "\n")
        print(f"Deployed {target}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Deployment failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
