import os, json, logging
from typing import Optional, Any

logger = logging.getLogger(__name__)

try:
    import redis
    _REDIS = True
except ImportError:
    _REDIS = False


class RedisCache:
    """Кешування відповідей Kubernetes API у Redis з TTL."""

    def __init__(self):
        self.client = None
        self.connected = False
        if not _REDIS:
            return
        url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        try:
            self.client = redis.from_url(url, decode_responses=True)
            self.client.ping()
            self.connected = True
            logger.info("Redis connected: %s", url)
        except Exception as e:
            logger.warning("Redis unavailable: %s", e)

    def get(self, key: str) -> Optional[Any]:
        if not self.connected:
            return None
        try:
            data = self.client.get(key)
            return json.loads(data) if data else None
        except Exception:
            return None

    def set(self, key: str, value: Any, ttl: int = 5):
        if not self.connected:
            return
        try:
            self.client.setex(key, ttl, json.dumps(value, default=str))
        except Exception:
            pass

    @property
    def status(self) -> str:
        return "connected" if self.connected else "disconnected"
