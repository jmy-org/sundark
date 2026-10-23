import asyncio
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import main, service, settings, store, zotero
from app.errors import AIError, RateLimitError
from tests.pdfgen import make_pdf

ROOT = Path(__file__).resolve().parent.parent
DOC = {"pages": ["PAPER TEXT"], "meta": {"num_pages": 1, "title": "T"}}


class _StoreDirs:
    """A temporary data/ and papers/ for one test."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name).resolve()  # PAPERS_DIR is a resolved path
        self.patches = [
            patch.dict(os.environ, {"SUNDARK_SETTINGS": str(root / "settings.json")}),
            patch.object(store, "PDFS", root / "pdfs"),
            patch.object(store, "DOCS", root / "docs"),
            patch.object(store, "CACHE", root / "cache"),
            patch.object(store, "CHATS", root / "chats"),
            patch.object(store, "PAPERS", root / "papers"),
            patch.object(service, "PAPERS_DIR", root / "library"),
        ]
        for p in self.patches:
            p.start()
        for d in ("pdfs", "docs", "cache", "library"):
            (root / d).mkdir()
        os.environ.pop("SUNDARK_BACKEND", None)
        settings.save("hermes", {}, 8)
        self.root = root

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.dir.cleanup()

    def put_doc(self, doc_id="d", doc=DOC):
        store.save_doc(doc_id, json.loads(json.dumps(doc)))


class CoreBoundaryTests(unittest.TestCase):
    def test_service_imports_no_web_framework(self):
        # Any adapter (HTTP today, MCP later) must be able to use the core without FastAPI.
        code = (
            "import sys, app.service\n"
            "bad = sorted(m for m in sys.modules"
            " if m.split('.')[0] in ('fastapi', 'starlette', 'pydantic'))\n"
            "assert not bad, bad\n"
        )
        r = subprocess.run(
            [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 0, r.stderr)


class ServiceTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    async def test_unknown_doc_is_not_found(self):
        with self.assertRaises(service.NotFoundError):
            await service.summarize("missing")
        with self.assertRaises(service.NotFoundError):
            service.chat_history("missing")
        with self.assertRaises(service.NotFoundError):
            service.pdf_path("missing")

    async def test_bad_language_is_rejected_before_doc_lookup(self):
        with self.assertRaises(service.InvalidRequestError):
            await service.summarize("missing", "xx-not-a-language")

    async def test_page_out_of_range(self):
        self.put_doc()
        with self.assertRaises(service.InvalidRequestError):
            await service.page_layout("d", 1)
        with self.assertRaises(service.InvalidRequestError):
            await service.translate("d", -1)

    async def test_summary_is_generated_once_then_cached(self):
        self.put_doc()
        with patch("app.ai.summarize", new=AsyncMock(return_value="S")) as gen:
            first = await service.summarize("d")
            second = await service.summarize("d")
        self.assertEqual(first, {"summary": "S"})
        self.assertEqual(second, first)
        gen.assert_awaited_once()

    async def test_anatomy_quotes_are_checked_against_the_paper(self):
        self.put_doc()
        result = {
            "problem": {"points": [{"quote": "PAPER TEXT"}, {"quote": "invented"}]}
        }
        with patch("app.ai.anatomy", new=AsyncMock(return_value=result)):
            out = await service.anatomy("d")
        flags = [p["verified"] for p in out["problem"]["points"]]
        self.assertEqual(flags, [True, False])

    async def test_chat_appends_to_the_papers_history(self):
        self.put_doc()
        with patch("app.ai.chat", new=AsyncMock(return_value="A")):
            self.assertEqual(await service.chat("d", "Q?"), "A")
        self.assertEqual(
            service.chat_history("d"),
            [{"role": "user", "text": "Q?"}, {"role": "assistant", "text": "A"}],
        )
        service.chat_reset("d")
        self.assertEqual(service.chat_history("d"), [])

    async def test_explain_needs_text(self):
        self.put_doc()
        with self.assertRaises(service.InvalidRequestError):
            await service.explain("d", "   ")

    async def test_glossary_does_not_depend_on_chat_migration(self):
        self.put_doc()
        store.CHATS.mkdir()
        paths = (store._chat_path("file:d"), store.CHATS / "d.json")
        for path in paths:
            path.write_text("corrupt history", encoding="utf-8")
        with (
            patch.object(service.pdf_utils, "brief_source", return_value="PAPER"),
            patch.object(
                service.ai, "translate_brief", new=AsyncMock(return_value="G")
            ),
        ):
            self.assertEqual(await service.brief("d"), "G")
        for path in paths:
            self.assertEqual(path.read_text("utf-8"), "corrupt history")

    async def test_folder_path_cannot_escape_the_papers_folder(self):
        with self.assertRaises(service.InvalidRequestError):
            await service.open_folder_paper("../outside.pdf")
        with self.assertRaises(service.NotFoundError):
            await service.open_folder_paper("absent.pdf")

    async def test_unreadable_pdf_is_an_invalid_request(self):
        (service.PAPERS_DIR / "bad.pdf").write_bytes(b"not a pdf")
        with self.assertRaisesRegex(service.InvalidRequestError, "Could not read PDF"):
            await service.open_folder_paper("bad.pdf")

    async def test_file_read_failures_keep_the_http_error_contract(self):
        path = service.PAPERS_DIR / "paper.pdf"
        path.write_bytes(b"synthetic")
        for error in (PermissionError("synthetic denied"), FileNotFoundError("gone")):
            with (
                self.subTest(error=type(error).__name__),
                patch.object(Path, "read_bytes", side_effect=error),
                patch.object(zotero, "pdf_path", return_value=path),
                patch.object(zotero, "item_doi", return_value=None),
            ):
                with self.assertRaisesRegex(
                    service.InvalidRequestError, "Could not read PDF"
                ):
                    await service.open_folder_paper("paper.pdf")
                with self.assertRaisesRegex(
                    service.InvalidRequestError, "Could not read PDF"
                ):
                    await service.open_zotero_paper("item", "attachment")
                client = TestClient(main.app, raise_server_exceptions=False)
                for route, body in (
                    ("/api/open", {"rel": "paper.pdf"}),
                    ("/api/zotero/open", {"item": "item", "attachment": "attachment"}),
                ):
                    response = client.post(route, json=body)
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(
                        response.json(), {"detail": f"Could not read PDF: {error}"}
                    )

    async def test_upload_ingests_keeps_a_library_copy_and_prewarms(self):
        pdf = make_pdf(["A Paper Title\nSome body text."])
        with (
            patch("app.biblio.lookup", new=AsyncMock(return_value=None)),
            patch("app.service.schedule_prewarm", side_effect=lambda m: m) as warm,
        ):
            meta = await service.upload_paper("p.pdf", pdf)
        self.assertEqual(meta["doc_id"], store.doc_id_for(pdf))
        self.assertEqual(meta["paper_id"], f"file:{meta['doc_id']}")
        self.assertEqual((service.PAPERS_DIR / "p.pdf").read_bytes(), pdf)
        warm.assert_called_once_with(meta)
        with self.assertRaises(service.InvalidRequestError):
            await service.upload_paper("p.txt", pdf)
        with self.assertRaises(service.InvalidRequestError):
            await service.upload_paper("p.pdf", b"")

    async def test_zotero_open_passes_zoteros_doi_and_key_to_identity(self):
        pdf_file = self.root / "z.pdf"
        pdf_file.write_bytes(make_pdf(["Zotero Paper\nBody."]))
        with (
            patch("app.zotero.pdf_path", return_value=pdf_file),
            patch("app.zotero.item_doi", return_value="10.5555/z"),
            patch("app.biblio.lookup", new=AsyncMock(return_value=None)),
            patch("app.service.schedule_prewarm", side_effect=lambda m: m),
        ):
            meta = await service.open_zotero_paper("ITEM", "ATT")
        self.assertEqual(meta["paper_id"], "doi:10.5555/z")

    async def test_review_bundle_is_a_zip_named_by_its_slug(self):
        self.put_doc()
        pdf = self.root / "x.pdf"
        pdf.write_bytes(b"%PDF")
        with (
            patch("app.store.pdf_path", return_value=pdf),
            patch("app.ai.summarize", new=AsyncMock(return_value="S")),
            patch("app.ai.anatomy", new=AsyncMock(side_effect=AIError("bad json"))),
            patch("app.service._get_brief", new=AsyncMock(return_value="")),
            patch(
                "app.pdf_utils.figure_catalog",
                return_value={"figures": [], "has_math": False},
            ),
            patch(
                "app.ai.review",
                new=AsyncMock(return_value={"title": "My Note", "body": "Body."}),
            ),
        ):
            slug, data = await service.review_bundle("d")
        self.assertEqual(slug, "my-note")
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            self.assertEqual(z.namelist(), ["my-note/index.md"])
            self.assertIn("Body.", z.read("my-note/index.md").decode())


_HOLD_CHAT_LOCK = """
import select, sys
from pathlib import Path
from app import store
store.CHATS = Path(sys.argv[1])
with store._chat_lock(store.CHATS / sys.argv[2]):
    print("held", flush=True)
    select.select([sys.stdin], [], [], float(sys.argv[3]))
"""


class ChatMigrationLoopTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    """Another process holding a chat lock must not stall the event loop."""

    async def while_chat_lock_held(self, name, make_call):
        """Run `make_call()` while another process holds `name`'s chat lock; return its
        result and the longest stall a ticker on the loop saw."""
        store.CHATS.mkdir(exist_ok=True)
        # The holder lets go by itself after 3s, so a blocked loop still ends.
        holder = subprocess.Popen(
            [sys.executable, "-c", _HOLD_CHAT_LOCK, str(store.CHATS), name, "3"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        ticks = []

        async def ticker():
            while True:
                ticks.append(time.monotonic())
                await asyncio.sleep(0.02)

        tick = asyncio.create_task(ticker())
        try:
            line = await asyncio.wait_for(asyncio.to_thread(holder.stdout.readline), 30)
            self.assertEqual(line.strip(), "held")
            call = asyncio.create_task(make_call())
            await asyncio.sleep(0.5)
            self.assertFalse(call.done())
            holder.stdin.write("go\n")
            holder.stdin.flush()
            result = await asyncio.wait_for(call, 10)
            await asyncio.to_thread(holder.wait, 10)
        finally:
            tick.cancel()
            if holder.poll() is None:
                holder.kill()
            holder.communicate()
        return result, max(b - a for a, b in zip(ticks, ticks[1:]))

    async def reopen_from_zotero(self, held):
        pdf = make_pdf(["Locked Paper\nBody."])
        doc_id = store.doc_id_for(pdf)
        with patch("app.biblio.lookup", new=AsyncMock(return_value=None)):
            await service._ingest(pdf)
            legacy, previous = held(doc_id)
            meta, stall = await self.while_chat_lock_held(
                legacy.name,
                lambda: service._ingest(pdf, {"key": "K", "doi": "10.5555/z"}),
            )
        self.assertLess(stall, 0.25)
        self.assertEqual(meta["paper_id"], "doi:10.5555/z")
        self.assertEqual(store.load_doc(doc_id)["meta"]["paper_id"], "doi:10.5555/z")
        self.assertEqual(store.chat_get("doi:10.5555/z"), [{"text": "kept"}])
        return doc_id, previous

    async def test_identity_waits_for_a_held_legacy_chat_off_the_loop(self):
        def held(doc_id):
            legacy = store.CHATS / f"{doc_id}.json"
            legacy.write_text(json.dumps([{"text": "kept"}]))
            return legacy, legacy

        _, legacy = await self.reopen_from_zotero(held)
        self.assertFalse(legacy.exists())

    async def test_identity_waits_for_a_held_previous_chat_off_the_loop(self):
        def held(doc_id):
            store.chat_put(f"file:{doc_id}", [{"text": "kept"}])
            path = store._chat_path(f"file:{doc_id}")
            return path, path

        doc_id, _ = await self.reopen_from_zotero(held)
        self.assertEqual(store.chat_get(f"file:{doc_id}"), [])

    async def test_identity_cancelled_while_queued_keeps_paper_and_chat_together(self):
        pdf = make_pdf(["Locked Paper\nBody."])
        doc_id = store.doc_id_for(pdf)
        loop = asyncio.get_running_loop()
        pool = ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(pool)
        busy = threading.Event()
        with patch("app.biblio.lookup", new=AsyncMock(return_value=None)):
            await service._ingest(pdf)
            store.chat_put(f"file:{doc_id}", [{"text": "kept"}])
            occupied = asyncio.ensure_future(asyncio.to_thread(busy.wait, 10))
            try:
                opening = asyncio.create_task(
                    service._ingest(pdf, {"key": "K", "doi": "10.5555/z"})
                )
                for _ in range(200):
                    if pool._work_queue.qsize() or opening.done():
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(pool._work_queue.qsize(), 1)
                opening.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await opening
            finally:
                busy.set()
                await occupied
                pool.shutdown(wait=True)
        pid = store.load_doc(doc_id)["meta"]["paper_id"]
        self.assertEqual(store.chat_get(pid), [{"text": "kept"}])

    async def test_review_waits_for_a_held_legacy_chat_off_the_loop(self):
        self.put_doc()
        store.CHATS.mkdir()
        legacy = store.CHATS / "d.json"
        legacy.write_text(json.dumps([{"text": "kept"}]))
        pdf = self.root / "x.pdf"
        pdf.write_bytes(b"%PDF")
        review = AsyncMock(return_value={"title": "My Note", "body": "Body."})
        with (
            patch("app.store.pdf_path", return_value=pdf),
            patch("app.ai.summarize", new=AsyncMock(return_value="S")),
            patch("app.ai.anatomy", new=AsyncMock(side_effect=AIError("bad json"))),
            patch("app.service._get_brief", new=AsyncMock(return_value="")),
            patch(
                "app.pdf_utils.figure_catalog",
                return_value={"figures": [], "has_math": False},
            ),
            patch("app.ai.review", new=review),
        ):
            (slug, _), stall = await self.while_chat_lock_held(
                "d.json", lambda: service.review_bundle("d")
            )
        self.assertLess(stall, 0.25)
        self.assertEqual(slug, "my-note")
        self.assertEqual(review.await_args.kwargs["chat_turns"], [{"text": "kept"}])
        self.assertFalse(legacy.exists())
        self.assertEqual(store.chat_get("file:d"), [{"text": "kept"}])


class TranslateStreamTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    async def collect(self, events):
        return [e async for e in events]

    async def test_validation_happens_before_streaming(self):
        # Errors must surface while the adapter can still send a status code.
        with self.assertRaises(service.NotFoundError):
            service.translate_stream("missing", 0)
        self.put_doc()
        with self.assertRaises(service.InvalidRequestError):
            service.translate_stream("d", 5)

    async def test_complete_stream_is_cached_and_replayed_without_ai(self):
        self.put_doc()

        async def stream(segs, lang, brief=""):
            for s in segs:
                yield f"번역 {s}"

        with (
            patch("app.ai.translate_stream", new=stream),
            patch("app.service._get_brief", new=AsyncMock(return_value="")),
        ):
            live = await self.collect(
                service.translate_stream("d", 0, None, ["a", "b"])
            )
        self.assertEqual(live, [{"i": 0, "tr": "번역 a"}, {"i": 1, "tr": "번역 b"}])

        def fail(*_a, **_k):
            raise AssertionError("cached batch must not call the model")

        with patch("app.ai.translate_stream", new=fail):
            replay = await self.collect(
                service.translate_stream("d", 0, None, ["a", "b"])
            )
        self.assertEqual(replay, live)

    async def test_failed_stream_ends_with_an_error_event_and_is_not_cached(self):
        self.put_doc()

        async def stream(segs, lang, brief=""):
            yield "가"
            raise RateLimitError("limit")

        with (
            patch("app.ai.translate_stream", new=stream),
            patch("app.service._get_brief", new=AsyncMock(return_value="")),
        ):
            events = await self.collect(
                service.translate_stream("d", 0, None, ["a", "b"])
            )
        self.assertEqual(events[0], {"i": 0, "tr": "가"})
        self.assertEqual(events[-1], {"error": "limit", "rate_limited": True})
        self.assertFalse(
            any(p.name.startswith("tr_") for p in (store.CACHE / "d").glob("*"))
        )


class RouteDelegationTests(unittest.TestCase):
    """Routes only translate HTTP to service calls and service errors to status codes."""

    def setUp(self):
        self.client = TestClient(main.app)

    def test_json_routes_delegate_and_return_the_service_result(self):
        cases = [
            ("post", "/api/summarize", {"doc_id": "d"}, "summarize", {"summary": "S"}),
            ("post", "/api/anatomy", {"doc_id": "d"}, "anatomy", {"claim": {}}),
            ("post", "/api/translate", {"doc_id": "d", "page": 0}, "translate", {}),
            ("get", "/api/layout/d/0", None, "page_layout", {"words": []}),
            ("get", "/api/math/d/0", None, "page_math", {"equations": []}),
            ("post", "/api/open", {"rel": "a.pdf"}, "open_folder_paper", {"x": 1}),
        ]
        for method, url, body, name, result in cases:
            with self.subTest(url=url):
                with patch(f"app.service.{name}", new=AsyncMock(return_value=result)):
                    r = self.client.request(method, url, json=body)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json(), result)

    def test_route_arguments_reach_the_service(self):
        with patch("app.service.anatomy", new=AsyncMock(return_value={})) as fn:
            self.client.post(
                "/api/anatomy",
                json={"doc_id": "d", "output_language": "en", "force": True},
            )
        fn.assert_awaited_once_with("d", "en", True)
        with patch("app.service.chat", new=AsyncMock(return_value="A")) as fn:
            r = self.client.post("/api/chat", json={"doc_id": "d", "question": "Q"})
        fn.assert_awaited_once_with("d", "Q", None)
        self.assertEqual(r.json(), {"answer": "A"})

    def test_service_errors_map_to_status_codes(self):
        cases = [
            (service.NotFoundError("Unknown doc_id"), 404),
            (service.InvalidRequestError("page out of range"), 400),
            (zotero.ZoteroError("Zotero is not running"), 503),
        ]
        for exc, code in cases:
            with self.subTest(code=code):
                with patch("app.service.page_layout", new=AsyncMock(side_effect=exc)):
                    r = self.client.get("/api/layout/d/0")
                self.assertEqual(r.status_code, code)
                self.assertEqual(r.json(), {"detail": str(exc)})

    def test_anatomy_failure_keeps_its_message(self):
        with patch("app.service.anatomy", new=AsyncMock(side_effect=AIError("bad"))):
            r = self.client.post("/api/anatomy", json={"doc_id": "d"})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json(), {"detail": "분석 실패: bad"})

    def test_stream_route_writes_each_event_as_an_ndjson_line(self):
        async def events():
            yield {"i": 0, "tr": "가"}
            yield {"error": "x", "rate_limited": False}

        with patch("app.service.translate_stream", return_value=events()) as fn:
            r = self.client.post(
                "/api/translate_stream",
                json={"doc_id": "d", "page": 2, "segments": ["a"], "force": True},
            )
        fn.assert_called_once_with("d", 2, None, ["a"], True)
        self.assertEqual(r.headers["content-type"], "application/x-ndjson")
        self.assertEqual(
            r.text, '{"i": 0, "tr": "가"}\n{"error": "x", "rate_limited": false}\n'
        )

    def test_review_route_sends_the_bundle_as_an_attachment(self):
        with patch(
            "app.service.review_bundle", new=AsyncMock(return_value=("s", b"ZIP"))
        ):
            r = self.client.post("/api/review/d")
        self.assertEqual(r.content, b"ZIP")
        self.assertEqual(r.headers["content-type"], "application/zip")
        self.assertEqual(
            r.headers["content-disposition"], 'attachment; filename="s.zip"'
        )


if __name__ == "__main__":
    unittest.main()
