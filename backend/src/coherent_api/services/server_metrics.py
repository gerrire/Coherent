"""Small, bounded host metrics sampler; no Docker socket or process inspection."""

import asyncio
import json
import logging
import os
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import monotonic

from coherent_api.models.operational_metric import OperationalMetric


class ServerMetrics:
    def __init__(self, factory=None) -> None:
        self.factory = factory
        self.requests = deque(maxlen=10000)
        self.previous_network = None
        self.persisted_at = 0.0
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

    def observe(self, status: int, elapsed_ms: float):
        self.requests.append((monotonic(), status, elapsed_ms))

    async def run(self) -> None:
        from sqlalchemy import delete

        while True:
            point = await asyncio.to_thread(self.collect)
            recent = [item for item in self.requests if item[0] >= monotonic() - 60]
            durations = sorted(item[2] for item in recent)
            point.update(
                api_requests_minute=len(recent),
                api_errors_minute=sum(item[1] >= 500 for item in recent),
                api_p95_ms=round(durations[min(len(durations) - 1, int(len(durations) * 0.95))], 1)
                if durations
                else None,
            )
            try:
                network = {
                    line.split(":")[0].strip(): [int(v) for v in line.split(":")[1].split()]
                    for line in Path("/proc/net/dev").read_text().splitlines()[2:]
                    if ":" in line and not line.strip().startswith("lo:")
                }
                now = monotonic()
                values = (sum(v[0] for v in network.values()), sum(v[8] for v in network.values()))
                if self.previous_network:
                    previous, at = self.previous_network
                    point.update(
                        network_receive_bps=max(0, (values[0] - previous[0]) / (now - at)),
                        network_send_bps=max(0, (values[1] - previous[1]) / (now - at)),
                    )
                self.previous_network = (values, now)
            except (OSError, ValueError, IndexError):
                pass
            self.history.append(point)
            if self.factory and monotonic() - self.persisted_at >= 60:
                try:
                    async with self.factory() as session:
                        session.add(
                            OperationalMetric(
                                at=datetime.fromisoformat(point["at"]), payload=json.dumps(point)
                            )
                        )
                        await session.execute(
                            delete(OperationalMetric).where(
                                OperationalMetric.at < datetime.now(UTC) - timedelta(days=7)
                            )
                        )
                        await session.commit()
                    self.persisted_at = monotonic()
                except Exception:
                    logging.getLogger(__name__).exception("Could not persist operational sample")
            await asyncio.sleep(10)

    async def snapshot(self, hours: int = 24) -> dict:
        points = {}
        if self.factory:
            from sqlalchemy import select

            from coherent_api.models.operational_metric import OperationalMetric

            async with self.factory() as session:
                rows = await session.scalars(
                    select(OperationalMetric)
                    .where(OperationalMetric.at > datetime.now(UTC) - timedelta(hours=hours))
                    .order_by(OperationalMetric.at)
                )
                for row in rows:
                    value = json.loads(row.payload)
                    points[value["at"]] = value
        for point in self.history:
            points[point["at"]] = point
        samples = sorted(points.values(), key=lambda value: value["at"])
        step = max(1, len(samples) // 1500)
        return {"samples": samples[::step], "interval_seconds": 10, "retention_days": 7}
