from datetime import datetime

from sqlalchemy import DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column

from coherent_api.db.base import Base


class OperationalMetric(Base):
    __tablename__ = "operational_metrics"
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    payload: Mapped[str] = mapped_column(Text)
