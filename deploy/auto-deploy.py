#!/usr/bin/env python3
"""Deploy the latest main commit after its GitHub Actions build succeeds."""

import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tarfile
import time
from pathlib import Path
from urllib.error import HTTPError
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
    "docker",
    "compose",
    "--env-file",
    "deploy/.env",
    "-f",
    "deploy/compose.prod.yaml",
]
GIT_ENV = dict(os.environ, GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10")


def run(*args: str, timeout: int = 1800, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        check=False,
        text=True,
        timeout=timeout,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.stdout.strip():
        print(result.stdout.strip(), flush=True)
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result.stdout.strip()


def git(*args: str) -> str:
    return run("git", *args, timeout=120, env=GIT_ENV)


def github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "coherent-vps-deploy",
    }
    token_path = Path("/etc/coherent/github-token")
    try:
        descriptor = os.open(token_path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return headers
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != 0:
            raise RuntimeError("GitHub token must be a root-owned private regular file")
        raw = os.read(descriptor, 4097)
    finally:
        os.close(descriptor)
    token = raw.decode("ascii").strip()
    if not token or len(raw) > 4096 or any(char.isspace() for char in token):
        raise RuntimeError("GitHub token file has invalid format")
    headers["Authorization"] = "Bearer " + token
    return headers


def successful_build(sha: str) -> bool:
    query = urlencode(
        {"branch": "main", "event": "push", "head_sha": sha, "per_page": 1}
    )
    request = Request(
        f"{WORKFLOW_URL}?{query}",
        headers=github_headers(),
    )
    try:
        with urlopen(request, timeout=15) as response:
            runs = json.load(response).get("workflow_runs", [])
    except HTTPError as error:
        if error.code in (401, 403, 404):
            raise RuntimeError(
                "Cannot read GitHub build status; check /etc/coherent/github-token and repository Actions: read permission"
            ) from None
        raise

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
    domain = next(
        (
            line.removeprefix("PUBLIC_DOMAIN=").strip()
            for line in (ROOT / "deploy/.env").read_text().splitlines()
            if line.startswith("PUBLIC_DOMAIN=")
        ),
        "",
    )
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", domain):
        raise RuntimeError("PUBLIC_DOMAIN is missing or invalid")
    for attempt in range(12):
        try:
            for url in (
                f"https://{domain}/",
                f"https://{domain}/api/v1/health/ready",
                f"https://{domain}:8443/",
            ):
                with urlopen(url, timeout=10) as response:
                    if response.status != 200:
                        raise RuntimeError(f"{url} returned {response.status}")
            return
        except Exception:
            if attempt == 11:
                raise
            time.sleep(5)


def image_environment(sha: str) -> dict[str, str]:
    return {**os.environ, "COHERENT_IMAGE_TAG": sha}


def image_config_digest(reference: str) -> str:
    # Hash the actual OCI config from Docker's portable export. Image .Id and
    # container .Image may refer to different nodes in containerd's OCI index.
    saved = subprocess.Popen(
        ["docker", "image", "save", reference],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        configs = {}
        manifest = None
        with tarfile.open(fileobj=saved.stdout, mode="r|") as archive:
            for member in archive:
                if member.isfile() and member.size <= 2 * 1024**2:
                    data = archive.extractfile(member).read()
                    configs[member.name] = "sha256:" + hashlib.sha256(data).hexdigest()
                    if member.name == "manifest.json":
                        manifest = json.loads(data)
        if saved.wait(timeout=60) != 0 or not manifest or len(manifest) != 1:
            raise RuntimeError("Could not verify exported image config")
        return configs[manifest[0]["Config"]]
    finally:
        if saved.poll() is None:
            saved.kill()
            saved.wait()


def selected_image(reference: str) -> str:
    probe = run("docker", "create", "--pull", "never", "--network", "none", reference)
    try:
        descriptor = json.loads(
            run(
                "docker",
                "inspect",
                probe,
                "--format",
                "{{json .ImageManifestDescriptor}}",
            )
        )
        return (
            descriptor["digest"]
            if descriptor
            else run("docker", "inspect", probe, "--format", "{{.Image}}")
        )
    finally:
        run("docker", "rm", probe)


def load_verified_images(sha: str) -> None:
    """Download the workflow's exact images, check archive and loaded image IDs."""
    base = f"https://github.com/gerrire/Coherent/releases/download/deployment-{sha}"
    with urlopen(
        Request(base + "/manifest.json", headers=github_headers()), timeout=30
    ) as response:
        manifest = json.load(response)
    names = {"coherent-api", "coherent-web", "coherent-monitor-bot"}
    if (
        manifest.get("commit") != sha
        or set(manifest.get("images", {})) != names
        or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("archive_sha256", ""))
    ):
        raise RuntimeError("Deployment manifest does not match the approved commit")
    if shutil.disk_usage(ROOT).free < 3 * 1024**3:
        raise RuntimeError("Not enough free space to stage a deployment safely")
    with tempfile.TemporaryDirectory(
        prefix="coherent-images-", dir="/var/lib/coherent-deploy"
    ) as directory:
        archive = Path(directory) / "images.tar.gz"
        hasher = hashlib.sha256()
        size = 0
        with (
            urlopen(
                Request(base + "/images.tar.gz", headers=github_headers()), timeout=60
            ) as source,
            archive.open("wb") as target,
        ):
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > 2 * 1024**3:
                    raise RuntimeError("Deployment archive exceeds limit")
                target.write(chunk)
                hasher.update(chunk)
        if hasher.hexdigest() != manifest["archive_sha256"]:
            raise RuntimeError("Deployment archive checksum failed")
        run("docker", "load", "--input", str(archive))
    for name, expected in manifest["images"].items():
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected):
            raise RuntimeError("Invalid image digest")
        actual = image_config_digest(f"{name}:{sha}")
        if actual != expected:
            raise RuntimeError(f"Image digest mismatch: {name}")


def preserve_running_images(sha: str) -> None:
    for service, name in (
        ("api", "coherent-api"),
        ("web", "coherent-web"),
        ("monitor-bot", "coherent-monitor-bot"),
    ):
        container = run(*COMPOSE, "ps", "--quiet", service)
        if not container:
            raise RuntimeError(f"No running image to roll back: {service}")
        expected, reference = run(
            "docker", "inspect", container, "--format", "{{.Image}}\n{{.Config.Image}}"
        ).splitlines()
        descriptor = json.loads(
            run(
                "docker",
                "inspect",
                container,
                "--format",
                "{{json .ImageManifestDescriptor}}",
            )
        )
        expected = descriptor["digest"] if descriptor else expected
        if selected_image(reference) != expected:
            raise RuntimeError(
                f"Running image reference was replaced; cannot preserve {service} safely"
            )
        run("docker", "tag", reference, f"{name}:{sha}")


def prepare_private_storage(*, root_api: bool = False) -> None:
    # API runs as an unprivileged UID. Keys remain root-owned and read-only.
    for name in ("attachments", "vapid"):
        directory = ROOT / "data" / name
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for base, dirs, files in os.walk(directory, followlinks=False):
            for path in [Path(base), *[Path(base) / name for name in dirs + files]]:
                if path.is_symlink():
                    raise RuntimeError("Unexpected link in private storage")
                info = path.stat()
                if info.st_uid != 10001 or info.st_gid != 10001:
                    os.chown(path, 10001, 10001)
    keys = Path("/etc/coherent/keys")
    if keys.is_dir():
        os.chown(keys, 0, 0 if root_api else 10001)
        keys.chmod(0o700 if root_api else 0o750)
        for key in keys.glob("*.key"):
            if key.is_symlink():
                raise RuntimeError("Unexpected key link")
            os.chown(key, 0, 0 if root_api else 10001)
            key.chmod(0o600 if root_api else 0o640)


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
            cwd=ROOT,
            env=GIT_ENV,
            check=True,
            timeout=120,
        )
        load_verified_images(target)
        preserve_running_images(deployed)
        previous_user = run(
            "docker",
            "image",
            "inspect",
            f"coherent-api:{deployed}",
            "--format",
            "{{.Config.User}}",
        )
        run("sh", str(ROOT / "deploy/backup.sh"))
        git("merge", "--ff-only", target)
        try:
            prepare_private_storage()
            # Schema changes must remain compatible with the previous application.
            # Never restore a DB automatically: doing so could discard new messages.
            run(
                *COMPOSE,
                "run",
                "--rm",
                "--no-deps",
                "api",
                "alembic",
                "upgrade",
                "head",
                env=image_environment(target),
            )
            run(*COMPOSE, "up", "-d", "--no-build", env=image_environment(target))
            healthy()
        except Exception:
            print(
                "Deployment failed; restoring previous application images", flush=True
            )
            git("switch", "--detach", deployed)
            prepare_private_storage(root_api=previous_user in ("", "root", "0", "0:0"))
            run(*COMPOSE, "up", "-d", "--no-build", env=image_environment(deployed))
            healthy()
            raise
        temporary = STATE.with_suffix(".tmp")
        temporary.write_text(target + "\n")
        temporary.replace(STATE)
        print(f"Deployed {target}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Deployment failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
