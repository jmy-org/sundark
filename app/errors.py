"""Errors shared by every AI Backend. Messages are safe to show in the UI: they never
contain prompt text, PDF content, credentials, or raw provider error bodies."""

from __future__ import annotations

import re


class AIError(RuntimeError):
    """An AI Backend could not complete a request."""


class RateLimitError(AIError):
    """The user's subscription usage limit (or a provider rate limit) was hit."""


class ModelUnavailableError(AIError):
    """The chosen Model cannot be used with this account or AI Backend."""


class AuthError(AIError):
    """The AI Backend is signed out, or its sign-in expired and could not be refreshed."""


# Claude Code says "You've hit your limit", "You've hit your session limit", ...
_RATE = re.compile(
    r"\b429\b|rate.?limit|usage limit|too many requests|quota"
    r"|hit your (?:[\w-]+ ){0,2}limit|(?:session|weekly|spend) limit reached",
    re.I,
)
# Claude Code: "Not logged in · Please run /login", "Failed to authenticate: OAuth session
# expired and could not be refreshed", "OAuth token has expired", "Invalid API key".
_AUTH = re.compile(
    r"not logged in|please run /login|failed to authenticate|authentication_error"
    r"|oauth (?:session|token)[^.]{0,40}(?:expired|revoked)|invalid api key",
    re.I,
)
_MODEL = re.compile(
    r"model[^.]{0,80}not supported|model_not_found|invalid model|unknown model|"
    r"model[^.]{0,40}does not exist|not_found_error|issue with the selected model",
    re.I,
)


def classify(text: str) -> type[AIError]:
    """Map raw backend/provider error text to an error class (the text itself is dropped)."""
    if _RATE.search(text or ""):
        return RateLimitError
    if _AUTH.search(text or ""):
        return AuthError
    if _MODEL.search(text or ""):
        return ModelUnavailableError
    return AIError


def from_text(text: str, fallback: str) -> AIError:
    """Build a safe error: the class comes from the raw text, the message does not."""
    cls = classify(text)
    if cls is RateLimitError:
        return cls("Subscription usage limit reached; try again later")
    if cls is AuthError:
        return cls(
            "The AI Backend is not signed in, or its sign-in expired; sign in again"
        )
    if cls is ModelUnavailableError:
        return cls("This model is not available for your account on this AI Backend")
    return cls(fallback)
