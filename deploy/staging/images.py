#!/usr/bin/env python3
"""Package CI images and load verified staging images in rootless Docker."""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

REPO = "gerrire/Coherent"
BRANCH = "Gleb_test"
IMAGES = {"coherent-api", "coherent-web"}
MAX_ARCHIVE = 1024**3
MAX_UNPACKED = 2 * 1024**3
RESERVE = 256 * 1024**2
SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


def log(message):
    print(message, file=sys.stderr, flush=True)


def request(url):
    return urlopen(Request(url, headers={"User-Agent": "Coherent-staging-images"}), timeout=60)


def github(path):
    with request(f"https://api.github.com/repos/{REPO}{path}") as response:
        return json.loads(response.read(1024 * 1024))


def validate_run(run, sha):
    if not (
        run.get("head_sha") == sha
        and run.get("head_branch") == BRANCH
        and run.get("event") == "push"
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and run.get("path") == ".github/workflows/build-deploy.yml"
        and run.get("repository", {}).get("full_name") == REPO
    ):
        raise ValueError("Images require a successful Gleb_test push build for this exact commit")


def image_digest(reference):
    # Docker with containerd can report a manifest/index ID from image inspect.
    # Hash the actual config identified by Docker's portable archive instead.
    saved = subprocess.Popen(["docker", "image", "save", reference], stdout=subprocess.PIPE)
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
        if saved.wait(timeout=60) or not manifest or len(manifest) != 1:
            raise ValueError("Cannot verify Docker image config")
        return configs[manifest[0]["Config"]]
    finally:
        saved.stdout.close()
        if saved.poll() is None:
            saved.kill()
            saved.wait()


def validate_manifest(manifest, sha):
    if not (
        manifest.get("schema") == 1
        and manifest.get("commit") == sha
        and manifest.get("branch") == BRANCH
        and type(manifest.get("run_id")) is int
        and manifest["run_id"] > 0
        and type(manifest.get("email_test")) is bool
        and isinstance(manifest.get("images"), dict)
        and set(manifest["images"]) == IMAGES
        and all(
            isinstance(digest, str) and DIGEST.fullmatch(digest)
            for digest in manifest["images"].values()
        )
        and isinstance(manifest.get("archive_sha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", manifest["archive_sha256"])
        and type(manifest.get("archive_size")) is int
        and 0 < manifest["archive_size"] <= MAX_ARCHIVE
        and type(manifest.get("unpacked_size")) is int
        and 0 < manifest["unpacked_size"] <= MAX_UNPACKED
        and type(manifest.get("image_size")) is int
        and 0 < manifest["image_size"] <= MAX_UNPACKED
    ):
        raise ValueError("Invalid staging image manifest or commit mismatch")


def image_size_in_archive(path):
    # With containerd, image inspect .Size reports compressed blob sizes. Count
    # decompressed layer bytes in CI so the VPS reserves room for snapshots too.
    with tarfile.open(path, "r:gz") as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        layers = {layer for image in manifest for layer in image["Layers"]}
        total = 0
        for member in sorted(
            (archive.getmember(name) for name in layers), key=lambda item: item.offset_data
        ):
            with io.BufferedReader(archive.extractfile(member)) as source:
                magic = source.peek(4)[:4]
                if magic[:2] == b"\x1f\x8b":
                    with gzip.GzipFile(fileobj=source) as decoded:
                        while chunk := decoded.read(1024 * 1024):
                            total += len(chunk)
                            if total > MAX_UNPACKED:
                                raise ValueError("Uncompressed image layers exceed staging limit")
                elif magic == b"\x28\xb5\x2f\xfd":
                    raise ValueError("Staging layers must use gzip or uncompressed tar")
                else:
                    total += member.size
                if total > MAX_UNPACKED:
                    raise ValueError("Uncompressed image layers exceed staging limit")
    return total


def bundle(sha, destination):
    if os.environ.get("GITHUB_REF") != f"refs/heads/{BRANCH}":
        raise ValueError("Staging images must be published from Gleb_test")
    destination.mkdir(parents=True, exist_ok=True)
    references = [f"{name}:{sha}" for name in sorted(IMAGES)]
    digests = {name: image_digest(f"{name}:{sha}") for name in sorted(IMAGES)}
    archive = destination / "images.tar.gz"
    with archive.open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", compresslevel=1, mtime=0) as compressed:
            saved = subprocess.Popen(
                ["docker", "image", "save", *references], stdout=subprocess.PIPE
            )
            try:
                shutil.copyfileobj(saved.stdout, compressed, length=1024 * 1024)
                if saved.wait(timeout=60):
                    raise RuntimeError("Could not export staging images")
            finally:
                saved.stdout.close()
                if saved.poll() is None:
                    saved.kill()
                    saved.wait()
    # Bound disk use before docker load; shared layers are counted once in this archive.
    with gzip.open(archive, "rb") as source:
        unpacked_size = sum(len(chunk) for chunk in iter(lambda: source.read(1024 * 1024), b""))
    compose = Path("deploy/staging/compose.yaml").read_text().splitlines()
    email_test = any(
        line in compose
        for line in ("      APP_ENV: staging", "      APP_ENV: ${STAGING_APP_ENV:-staging}")
    ) and any(
        line in compose
        for line in (
            '      TEST_EMAIL_VERIFICATION_BYPASS: "true"',
            "      TEST_EMAIL_VERIFICATION_BYPASS: ${STAGING_EMAIL_TEST:-true}",
        )
    )
    with archive.open("rb") as source:
        archive_digest = hashlib.file_digest(source, "sha256").hexdigest()
    manifest = {
        "schema": 1,
        "commit": sha,
        "branch": BRANCH,
        "run_id": int(os.environ["GITHUB_RUN_ID"]),
        "email_test": email_test,
        "images": digests,
        "archive_sha256": archive_digest,
        "archive_size": archive.stat().st_size,
        "unpacked_size": unpacked_size,
        "image_size": image_size_in_archive(archive),
    }
    validate_manifest(manifest, sha)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"Packaged {sha[:12]}: {archive.stat().st_size // 1024**2} MiB")


def download(url, path, size, digest):
    hasher = hashlib.sha256()
    received = 0
    with request(url) as source, path.open("xb") as target:
        while chunk := source.read(1024 * 1024):
            received += len(chunk)
            if received > size:
                raise ValueError("Staging archive exceeds declared size")
            target.write(chunk)
            hasher.update(chunk)
    if received != size or hasher.hexdigest() != digest:
        raise ValueError("Staging archive checksum or size mismatch")


def verify_archive(path, manifest):
    # Validate without extracting anything on the host. Only Docker reads layers.
    configs = {}
    images = None
    unpacked = 0
    with tarfile.open(path, mode="r|gz") as archive:
        for member in archive:
            unpacked += member.size + 512
            if unpacked > manifest["unpacked_size"] or unpacked > MAX_UNPACKED:
                raise ValueError("Staging archive exceeds unpacked size limit")
            if member.isfile() and member.size <= 2 * 1024**2:
                data = archive.extractfile(member).read()
                configs[member.name] = "sha256:" + hashlib.sha256(data).hexdigest()
                if member.name == "manifest.json":
                    images = json.loads(data)
    expected = {
        f"{name}:{manifest['commit']}": digest for name, digest in manifest["images"].items()
    }
    actual = {}
    if not isinstance(images, list):
        raise ValueError("Missing Docker archive manifest")
    for item in images:
        for tag in item.get("RepoTags") or []:
            if tag in actual:
                raise ValueError("Duplicate Docker image tag")
            actual[tag] = configs.get(item.get("Config"))
    if actual != expected:
        raise ValueError("Archive image tags or config digests do not match the approved manifest")


def load(sha):
    base = f"https://github.com/{REPO}/releases/download/staging-deployment-{sha}"
    with request(base + "/manifest.json") as response:
        manifest = json.loads(response.read(64 * 1024))
    validate_manifest(manifest, sha)
    validate_run(github(f"/actions/runs/{manifest['run_id']}"), sha)
    # Account for the downloaded archive, Docker content store and extracted layers.
    # Layer bytes include files removed by later layers, giving a safe upper bound.
    required = (
        manifest["archive_size"] + manifest["unpacked_size"] + manifest["image_size"] + RESERVE
    )
    if shutil.disk_usage(Path.home()).free < required:
        raise RuntimeError(f"Need {required // 1024**2} MiB free to load staging images safely")
    with tempfile.TemporaryDirectory(prefix="images.", dir=Path.home()) as scratch:
        archive = Path(scratch) / "images.tar.gz"
        log(f"Downloading verified CI images for {sha[:12]}")
        download(
            base + "/images.tar.gz", archive, manifest["archive_size"], manifest["archive_sha256"]
        )
        verify_archive(archive, manifest)
        subprocess.run(
            ["docker", "image", "load", "--input", str(archive)],
            check=True,
            stdout=sys.stderr,
            timeout=600,
        )
    for name, expected in manifest["images"].items():
        if image_digest(f"{name}:{sha}") != expected:
            raise ValueError(f"Loaded image digest mismatch: {name}")
        info = json.loads(
            subprocess.check_output(["docker", "image", "inspect", f"{name}:{sha}"], text=True)
        )[0]
        if info.get("Os") != "linux" or info.get("Architecture") != "amd64":
            raise ValueError(f"Wrong image platform: {name}")
    log(f"Verified and loaded both CI images for {sha[:12]}")
    print("true" if manifest["email_test"] else "false")


def cleanup(keep):
    # Only retire our SHA tags. Docker refuses to remove images still in use.
    for name in sorted(IMAGES):
        tags = subprocess.check_output(
            ["docker", "image", "ls", name, "--format", "{{.Tag}}"], text=True
        ).splitlines()
        for tag in tags:
            if SHA.fullmatch(tag) and tag not in keep:
                subprocess.run(
                    ["docker", "image", "rm", f"{name}:{tag}"],
                    stdout=sys.stderr,
                    stderr=sys.stderr,
                    check=False,
                    timeout=60,
                )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    package = sub.add_parser("bundle")
    package.add_argument("sha")
    package.add_argument("destination", type=Path)
    loader = sub.add_parser("load")
    loader.add_argument("sha")
    cleaner = sub.add_parser("cleanup")
    cleaner.add_argument("keep", nargs="+")
    args = parser.parse_args()
    revisions = args.keep if args.command == "cleanup" else [args.sha]
    if not all(SHA.fullmatch(value) for value in revisions):
        parser.error("Expected full commit SHA")
    if args.command == "bundle":
        bundle(args.sha, args.destination)
    elif args.command == "load":
        load(args.sha)
    else:
        cleanup(set(args.keep))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"Staging images failed: {error}")
        sys.exit(1)
