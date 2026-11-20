import copy
import gzip
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "staging_images", Path(__file__).resolve().parents[1] / "images.py"
)
images = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(images)
COMMIT = "a" * 40
PREVIOUS = "b" * 40
OLD = "c" * 40


def manifest():
    return {
        "schema": 1,
        "commit": COMMIT,
        "branch": "Gleb_test",
        "run_id": 42,
        "email_test": True,
        "images": {name: "sha256:" + "d" * 64 for name in images.IMAGES},
        "archive_sha256": "e" * 64,
        "archive_size": 100,
        "unpacked_size": 10240,
        "image_size": 10240,
    }


def successful_run():
    return {
        "head_sha": COMMIT,
        "head_branch": "Gleb_test",
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "path": ".github/workflows/build-deploy.yml",
        "repository": {"full_name": "gerrire/Coherent"},
    }


class ImageVerificationTests(unittest.TestCase):
    def test_disk_budget_counts_decompressed_layers_and_shared_layers_once(self):
        compressed = b"highly compressible layer content" * 2048
        plain = b"uncompressed layer content" * 40
        payload = json.dumps(
            [
                {"Layers": ["shared", "plain"]},
                {"Layers": ["shared"]},
            ]
        ).encode()
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "archive.tar.gz"
            with tarfile.open(path, "w:gz") as archive:
                for name, data in (
                    ("shared", gzip.compress(compressed)),
                    ("plain", plain),
                    ("manifest.json", payload),
                ):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            self.assertEqual(images.image_size_in_archive(path), len(compressed) + len(plain))
            with patch.object(images, "MAX_UNPACKED", 1000), self.assertRaises(ValueError):
                images.image_size_in_archive(path)

    def test_accepts_exact_successful_push_and_manifest(self):
        images.validate_run(successful_run(), COMMIT)
        images.validate_manifest(manifest(), COMMIT)

    def test_rejects_unapproved_workflow_runs(self):
        for key, value in (
            ("head_sha", PREVIOUS),
            ("head_branch", "main"),
            ("event", "pull_request"),
            ("status", "in_progress"),
            ("conclusion", "failure"),
            ("path", ".github/workflows/other.yml"),
            ("repository", {"full_name": "someone/fork"}),
        ):
            with self.subTest(key=key):
                run = successful_run()
                run[key] = value
                with self.assertRaises(ValueError):
                    images.validate_run(run, COMMIT)

    def test_rejects_wrong_commit_unbounded_archive_and_runtime_metadata(self):
        for key, value in (
            ("commit", PREVIOUS),
            ("branch", "main"),
            ("run_id", "42"),
            ("email_test", "true"),
            ("archive_size", True),
            ("archive_size", 0),
            ("archive_size", images.MAX_ARCHIVE + 1),
            ("unpacked_size", images.MAX_UNPACKED + 1),
            ("image_size", images.MAX_UNPACKED + 1),
            ("archive_sha256", "bad"),
            ("images", {"other": "sha256:" + "d" * 64}),
            ("images", {"coherent-api": "bad", "coherent-web": "bad"}),
        ):
            with self.subTest(key=key, value=value):
                data = manifest()
                data[key] = value
                with self.assertRaises(ValueError):
                    images.validate_manifest(data, COMMIT)

    def test_archive_contains_only_approved_image_tags_and_configs(self):
        config = b'{"architecture":"amd64","os":"linux"}'
        digest = "sha256:" + hashlib.sha256(config).hexdigest()
        data = manifest()
        data["images"] = {name: digest for name in images.IMAGES}
        for extra_tag, expected_ok in ((False, True), (True, False)):
            with self.subTest(extra_tag=extra_tag), tempfile.TemporaryDirectory() as scratch:
                archive = Path(scratch) / "images.tar.gz"
                tags = [f"{name}:{COMMIT}" for name in sorted(images.IMAGES)]
                if extra_tag:
                    tags.append("postgres:latest")
                payload = json.dumps([{"Config": "config.json", "RepoTags": tags}]).encode()
                with tarfile.open(archive, "w:gz") as output:
                    for name, value in (("config.json", config), ("manifest.json", payload)):
                        member = tarfile.TarInfo(name)
                        member.size = len(value)
                        output.addfile(member, io.BytesIO(value))
                if expected_ok:
                    images.verify_archive(archive, data)
                    wrong = copy.deepcopy(data)
                    wrong["images"]["coherent-api"] = "sha256:" + "0" * 64
                    with self.assertRaises(ValueError):
                        images.verify_archive(archive, wrong)
                else:
                    with self.assertRaises(ValueError):
                        images.verify_archive(archive, data)

    def test_download_rejects_truncation_corruption_and_oversized_data(self):
        payload = b"a verified image archive"
        digest = hashlib.sha256(payload).hexdigest()
        for received in (payload, payload[:-1], b"x" * len(payload), payload + b"x"):
            with self.subTest(received=received), tempfile.TemporaryDirectory() as scratch:
                with patch.object(images, "request", return_value=io.BytesIO(received)):
                    path = Path(scratch) / "archive"
                    if received == payload:
                        images.download("https://example.invalid", path, len(payload), digest)
                        self.assertEqual(path.read_bytes(), payload)
                    else:
                        with self.assertRaises(ValueError):
                            images.download("https://example.invalid", path, len(payload), digest)

    def load_patches(self, data, *, free=10 * 1024**3):
        return (
            patch.object(images, "request", return_value=io.BytesIO(json.dumps(data).encode())),
            patch.object(images, "github", return_value=successful_run()),
            patch.object(images.shutil, "disk_usage", return_value=SimpleNamespace(free=free)),
        )

    def test_load_rejects_insufficient_disk_before_download_or_docker(self):
        patches = self.load_patches(manifest(), free=1)
        with patches[0], patches[1], patches[2], patch.object(images, "download") as download:
            with patch.object(images.subprocess, "run") as docker:
                with self.assertRaises(RuntimeError):
                    images.load(COMMIT)
                download.assert_not_called()
                docker.assert_not_called()

    def test_corrupt_archive_is_never_loaded_into_docker(self):
        patches = self.load_patches(manifest())
        with patches[0], patches[1], patches[2]:
            with patch.object(images, "download", side_effect=ValueError("checksum mismatch")):
                with patch.object(images.subprocess, "run") as docker:
                    with self.assertRaises(ValueError):
                        images.load(COMMIT)
                    docker.assert_not_called()

    def test_failed_provenance_is_rejected_before_download(self):
        patches = self.load_patches(manifest())
        run = successful_run()
        run["conclusion"] = "failure"
        with patches[0], patches[1] as github, patches[2]:
            github.return_value = run
            with patch.object(images, "download") as download:
                with self.assertRaises(ValueError):
                    images.load(COMMIT)
                download.assert_not_called()

    def test_load_verifies_loaded_images_and_returns_runtime_flag(self):
        for mismatch, expected_ok in ((False, True), (True, False)):
            with self.subTest(mismatch=mismatch):
                patches = self.load_patches(manifest())
                with patches[0], patches[1], patches[2]:
                    with patch.object(images, "download"), patch.object(images, "verify_archive"):
                        with patch.object(images.subprocess, "run") as docker:
                            with patch.object(
                                images,
                                "image_digest",
                                return_value=("sha256:" + ("0" if mismatch else "d") * 64),
                            ):
                                with (
                                    patch.object(
                                        images.subprocess,
                                        "check_output",
                                        return_value=('[{"Os":"linux","Architecture":"amd64"}]'),
                                    ),
                                    patch("sys.stdout", new_callable=io.StringIO) as output,
                                ):
                                    if expected_ok:
                                        images.load(COMMIT)
                                        self.assertEqual(output.getvalue(), "true\n")
                                    else:
                                        with self.assertRaises(ValueError):
                                            images.load(COMMIT)
                                        self.assertEqual(output.getvalue(), "")
                                    self.assertEqual(
                                        docker.call_args.args[0][:3], ["docker", "image", "load"]
                                    )

    def test_cleanup_preserves_current_previous_and_unrelated_tags(self):
        with (
            patch.object(
                images.subprocess,
                "check_output",
                return_value=(f"{COMMIT}\n{PREVIOUS}\n{OLD}\nlatest\n<none>\n"),
            ),
            patch.object(images.subprocess, "run") as docker,
        ):
            images.cleanup({COMMIT, PREVIOUS})
            self.assertEqual(
                [call.args[0] for call in docker.call_args_list],
                [["docker", "image", "rm", f"{name}:{OLD}"] for name in sorted(images.IMAGES)],
            )
            self.assertTrue(all("--force" not in call.args[0] for call in docker.call_args_list))


if __name__ == "__main__":
    unittest.main()
