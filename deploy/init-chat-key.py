#!/usr/bin/env python3
"""Create the cloud master key once. Never replace an existing key."""

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--path", type=Path, default=Path("/etc/coherent/keys/chat-master.key")
    )
    path = parser.parse_args().path
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.stat().st_mode & 0o077:
        raise RuntimeError("The key directory must have mode 0700")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, os.urandom(32))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    print(f"Key created: {path}. Back it up separately from database backups.")


if __name__ == "__main__":
    main()
