#!/usr/bin/env python3
"""Pull DB + cloud key directly into GPG encryption on a separate computer.

Only public-key encryption is used during scheduled runs. No plaintext backup or
server key is written locally. Keep the private decryption key separately safe.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

REMOTE = r"""
import io,json,pathlib,sys,tarfile
root=pathlib.Path('/opt/coherent')
backups=sorted((root/'backups').glob('coherent-*.dump'))
if not backups: raise SystemExit('No completed database backup')
latest=backups[-1]
key=pathlib.Path('/etc/coherent/keys/chat-master.key')
if not key.is_file(): raise SystemExit('Cloud key is missing')
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:
 archive.add(latest,arcname='database.dump',recursive=False)
 archive.add(key,arcname='keys/chat-master.key',recursive=False)
 metadata=json.dumps({'created_at':latest.stem.removeprefix('coherent-'),'format':1}).encode()
 info=tarfile.TarInfo('manifest.json');info.size=len(metadata);info.mode=0o600
 archive.addfile(info,io.BytesIO(metadata))
"""

REPORT = r"""
import datetime,json,pathlib,sys
path=pathlib.Path('/opt/coherent/data/operations/backup-status.json')
path.parent.mkdir(parents=True,exist_ok=True)
try: report=json.loads(path.read_text())
except (OSError,ValueError): report={}
report.update(offsite_last_success_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),offsite_bytes=int(sys.argv[1]))
temporary=path.with_suffix('.offsite.tmp')
temporary.write_text(json.dumps(report));temporary.chmod(0o644);temporary.replace(path)
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    destination = Path(config["directory"]).expanduser()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    if shutil.disk_usage(destination).free < 1024**3:
        raise RuntimeError("Insufficient free space on backup computer")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = destination / f"coherent-{stamp}.tar.gpg"
    partial = target.with_suffix(".partial")
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]
    if config.get("interface"):
        ssh += ["-B", config["interface"]]
    ssh += [config["host"]]
    remote_command = "python3 -c " + __import__("shlex").quote(REMOTE)
    gpg = [
        "gpg",
        "--homedir",
        config["gpg_home"],
        "--batch",
        "--trust-model",
        "always",
        "--recipient",
        config["recipient"],
        "--encrypt",
    ]
    try:
        remote = subprocess.Popen(
            [*ssh, remote_command], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        with partial.open("xb") as output:
            os.chmod(partial, 0o600)
            encrypted = subprocess.Popen(
                gpg, stdin=remote.stdout, stdout=output, stderr=subprocess.DEVNULL
            )
            remote.stdout.close()
            try:
                encrypt_status = encrypted.wait(timeout=600)
                remote_status = remote.wait(timeout=30)
            except subprocess.TimeoutExpired:
                encrypted.kill()
                remote.kill()
                encrypted.wait()
                remote.wait()
                raise RuntimeError("Backup transfer timed out") from None
            if encrypt_status or remote_status:
                raise RuntimeError("Backup transfer or encryption failed")
            output.flush()
            os.fsync(output.fileno())
        partial.replace(target)
        with target.open("rb") as saved:
            digest = hashlib.file_digest(saved, "sha256").hexdigest()
        (destination / "last-success.json").write_text(
            json.dumps(
                {
                    "at": datetime.now(UTC).isoformat(),
                    "file": target.name,
                    "bytes": target.stat().st_size,
                    "sha256": digest,
                }
            )
        )
        for old in sorted(destination.glob("coherent-*.tar.gpg"))[:-14]:
            old.unlink()
        subprocess.run(
            [
                *ssh,
                "python3 -c "
                + __import__("shlex").quote(REPORT)
                + " "
                + str(target.stat().st_size),
            ],
            check=True,
            timeout=30,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"Encrypted offsite backup saved: {target.name}")
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
