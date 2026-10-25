"""Small, bounded host metrics sampler; no Docker socket or process inspection."""

import asyncio
import os
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic


class ServerMetrics:
    def __init__(self) -> None:
        self.history: deque[dict] = deque(maxlen=120)
        self.previous_cpu: tuple[int, int] | None = None
        self.started = monotonic()

    def collect(self) -> dict:
        point: dict = {
            "at": datetime.now(UTC).isoformat(),
            "cpu_percent": None,
            "memory_used_bytes": None,
            "memory_total_bytes": None,
            "memory_percent": None,
            "host_uptime_seconds": None,
        }
        try:
            values = [
                int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]
            ]
            total, idle = sum(values), values[3] + values[4]
            if self.previous_cpu is not None:
                elapsed = total - self.previous_cpu[0]
                if elapsed > 0:
                    point["cpu_percent"] = round(
                        max(0, min(100, 100 * (1 - (idle - self.previous_cpu[1]) / elapsed))), 1
                    )
            self.previous_cpu = (total, idle)
            memory = {
                line.split(":", 1)[0]: int(line.split()[1]) * 1024
                for line in Path("/proc/meminfo").read_text().splitlines()
                if line.startswith(("MemTotal:", "MemAvailable:"))
            }
            used = memory["MemTotal"] - memory["MemAvailable"]
            point.update(
                memory_used_bytes=used,
                memory_total_bytes=memory["MemTotal"],
                memory_percent=round(used / memory["MemTotal"] * 100, 1),
            )
            point["host_uptime_seconds"] = int(float(Path("/proc/uptime").read_text().split()[0]))
        except (OSError, ValueError, KeyError, IndexError):
            # A development host may not expose Linux host counters.
            pass
        try:
            point["load_average"] = list(os.getloadavg())
        except (OSError, AttributeError):
            point["load_average"] = None
        point["cpu_count"] = os.cpu_count()
        point["api_uptime_seconds"] = int(monotonic() - self.started)
        return point

    async def run(self) -> None:
        while True:
            self.history.append(await asyncio.to_thread(self.collect))
            await asyncio.sleep(10)

    def snapshot(self) -> dict:
        return {"samples": list(self.history), "interval_seconds": 10}
