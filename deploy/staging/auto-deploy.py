#!/usr/bin/env python3
"""Pull approved, green Gleb_test commits into the staging-only runtime."""

import fcntl
import json
import re
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CONFIG = Path("/etc/coherent-staging")
REPO = "gerrire/Coherent"
BRANCH = "Gleb_test"
REMOTE = f"https://github.com/{REPO}.git"
API = f"https://api.github.com/repos/{REPO}"
CACHE = CONFIG / "deploy-git"
SHA = re.compile(r"[a-f0-9]{40}")


def github(path):
    request = Request(
        API + path,
        headers={"User-Agent": "Coherent-staging", "Accept": "application/vnd.github+json"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def git(*args, check=True, stdout=None):
    return subprocess.run(
        ["env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
         "GIT_NO_REPLACE_OBJECTS=1", "GIT_TERMINAL_PROMPT=0",
         "git", "-c", "core.hooksPath=/dev/null", f"--git-dir={CACHE}", *args],
        cwd=CONFIG, timeout=90, check=check, stdout=stdout,
    )


def approved(commit):
    local = CONFIG / "approved-sha"
    if local.exists() and local.read_text().strip() == commit:
        return True
    for comment in github(f"/commits/{commit}/comments?per_page=100"):
        if (
            comment.get("user", {}).get("login") == REPO.split("/")[0]
            and comment.get("author_association") == "OWNER"
            and comment.get("commit_id") == commit
            and comment.get("body", "").strip() == "deploy-staging"
        ):
            return True
    return False


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
    if not approved(target):
        print(f"{target[:12]} is waiting for owner approval", flush=True)
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

    if not CACHE.exists():
        git("init", "--bare", "--quiet")
    git("fetch", "--quiet", "--no-tags", "--depth=1", REMOTE, f"{target}:refs/staging/target")
    reuse = git("cat-file", "-e", f"{current}^{{commit}}", check=False).returncode == 0
    if not reuse:
        reuse = git("fetch", "--quiet", "--no-tags", "--depth=1", REMOTE,
                    f"{current}:refs/staging/current", check=False).returncode == 0
    reuse = reuse and git(
        "diff", "--quiet", current, target, "--", "crates/coherent-crypto", "deploy/Dockerfile.web",
        check=False,
    ).returncode == 0
    with tempfile.TemporaryDirectory(prefix="coherent-staging-deploy-") as scratch:
        archive = Path(scratch) / "source.tar"
        with archive.open("wb") as output:
            git("archive", "--format=tar", target, stdout=output)
        print(f"Deploying approved {target[:12]} (cached crypto: {reuse})", flush=True)
        command = ["/usr/local/sbin/coherent-staging", "deploy-reviewed", str(archive)]
        if reuse:
            command.append("--reuse-crypto")
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
