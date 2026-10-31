import re

from rest_framework.throttling import SimpleRateThrottle


class ScopedIPThrottle(SimpleRateThrottle):
    """Per-IP throttle that also understands multi-unit periods like ``1/5s``."""

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}

    def parse_rate(self, rate):
        if rate is None:
            return None, None
        num, period = rate.split("/")
        match = re.fullmatch(r"(\d*)([smhd])", period)
        if not match:
            raise ValueError(f"Invalid throttle period: {period!r}")
        seconds = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match[2]]
        return int(num), int(match[1] or 1) * seconds


class MirrorPollThrottle(ScopedIPThrottle):
    scope = "mirror_poll"


class MirrorVersionThrottle(ScopedIPThrottle):
    scope = "mirror_version"


class CustomerUploadThrottle(ScopedIPThrottle):
    scope = "customer_upload"


class CustomerRegisterThrottle(ScopedIPThrottle):
    scope = "customer_register"


class CustomerSpinThrottle(ScopedIPThrottle):
    scope = "customer_spin"


class PhoneThrottle(ScopedIPThrottle):
    """Limits by mobile number instead of IP, so one number can't be hammered
    from many networks."""

    scope = "customer_phone"

    def get_cache_key(self, request, view):
        phone = str(request.data.get("phone", ""))[:20]
        if not phone:
            return None
        return self.cache_format % {"scope": self.scope, "ident": phone}


class BurstThrottle(ScopedIPThrottle):
    """Overall per-IP ceiling for every API endpoint."""

    scope = "burst"
