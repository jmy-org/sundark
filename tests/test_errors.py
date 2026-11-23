import unittest

from app.errors import (
    AIError,
    AuthError,
    ModelUnavailableError,
    RateLimitError,
    classify,
    from_text,
)


class ClassifyTests(unittest.TestCase):
    def test_rate_limit_phrases(self):
        for text in (
            "HTTP 429 Too Many Requests",
            "Claude AI usage limit reached",
            "rate_limit_error",
            "You exceeded your current quota",
            # Only "hit your ... limit" decides; the reset time and zone after it vary.
            "You've hit your limit · resets 5pm",
            "You've hit your limit · resets 5pm (UTC)",
            "You've hit your session limit · resets 3pm",
            "You've hit your weekly limit",
        ):
            self.assertIs(classify(text), RateLimitError, text)

    def test_signed_out_phrases(self):
        # What Claude Code returns as its error result when it cannot use its login.
        for text in (
            "Not logged in · Please run /login",
            "Failed to authenticate: OAuth session expired and could not be refreshed",
            "OAuth token has expired · Please run /login",
            'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
        ):
            self.assertIs(classify(text), AuthError, text)

    def test_signed_out_message_carries_no_raw_text(self):
        err = from_text("Not logged in · Please run /login", "fallback")
        self.assertIsInstance(err, AuthError)
        self.assertNotIn("/login", str(err))

    def test_unavailable_model_phrases(self):
        for text in (
            "The 'gpt-6.1-luna' model is not supported when using Codex with a ChatGPT account.",
            "model_not_found",
            "Invalid model: foo",
            "There's an issue with the selected model (foo). It may not exist or you may "
            "not have access to it. Run --model to pick a different model.",
        ):
            self.assertIs(classify(text), ModelUnavailableError, text)

    def test_other_text_is_plain_error(self):
        self.assertIs(classify("connection reset"), AIError)
        self.assertIs(
            classify("the copyright of the data is held by the authors"), AIError
        )
        self.assertTrue(issubclass(RateLimitError, AIError))
