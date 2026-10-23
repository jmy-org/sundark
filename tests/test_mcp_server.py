import asyncio
import base64
import io
import json
import os
import secrets
import socket
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx
import httpx2
import uvicorn
from fastapi.testclient import TestClient
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

from app import main, mcp_server, store
from app.errors import AIError, RateLimitError
from tests.test_service import DOC, _StoreDirs

ROOT = Path(__file__).resolve().parent.parent
DOC_ID = "0123456789abcdef"


def _writes(data: bytes, slug: str = "paper") -> AsyncMock:
    """A `service.write_review_bundle` stand-in that writes `data` as the bundle."""

    async def write(doc_id, language, out):
        out.write(data)
        return slug

    return AsyncMock(side_effect=write)


def _client(server=None) -> Client:
    return Client(server or mcp_server.build_server(), cache=None)


class ContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_and_their_operations(self):
        async with _client() as c:
            tools = {t.name: t for t in (await c.list_tools()).tools}
            templates = (await c.list_resource_templates()).resource_templates
        ops = {name: t.meta["sundark/operation"] for name, t in tools.items()}
        self.assertEqual(
            ops,
            {
                "reader_config": "read",
                "begin_upload": "cache",
                "upload_chunk": "cache",
                "finish_upload": "cache",
                "cancel_upload": "cache",
                "list_papers": "read",
                "open_paper": "cache",
                "zotero_status": "read",
                "zotero_collections": "read",
                "zotero_items": "read",
                "open_zotero_paper": "cache",
                "layout_status": "read",
                "page_layout": "cache",
                "page_math": "generate",
                "pdf_chunk": "read",
                "summarize": "generate",
                "anatomy": "generate",
                "translate_page": "generate",
                "translate_stream": "generate",
                "explain": "generate",
                "brief": "generate",
                "review": "generate",
                "review_chunk": "read",
                "release_review": "cache",
                "chat": "write",
                "chat_history": "read",
                "chat_reset": "write",
            },
        )
        for name, t in tools.items():
            a = t.annotations
            self.assertEqual(a.read_only_hint, ops[name] == "read", name)
            # Generation sends paper text to the chosen AI Backend.
            if ops[name] == "generate":
                self.assertTrue(a.open_world_hint, name)
        self.assertTrue(tools["chat_reset"].annotations.destructive_hint)
        # A retried upload step is not harmless: it opens another upload or cancels this one.
        for name in ("begin_upload", "upload_chunk"):
            self.assertFalse(tools[name].annotations.idempotent_hint, name)
        self.assertTrue(tools["cancel_upload"].annotations.idempotent_hint)
        # The reader's page data and bytes serve only the reader; opening shows it.
        ui = {n: t.meta.get("ui", {}).get("visibility") for n, t in tools.items()}
        self.assertEqual(
            {n for n, v in ui.items() if v == ["app"]},
            {
                "reader_config",
                "begin_upload",
                "upload_chunk",
                "finish_upload",
                "cancel_upload",
                "layout_status",
                "page_layout",
                "page_math",
                "pdf_chunk",
                "translate_page",
                "translate_stream",
                "review",
                "review_chunk",
                "release_review",
            },
        )
        self.assertEqual(ui["open_paper"], ["model", "app"])
        self.assertEqual(ui["open_zotero_paper"], ["model", "app"])
        self.assertIsNone(ui["chat"])
        self.assertEqual(templates, [])

    async def test_no_settings_credentials_or_arbitrary_access(self):
        async with _client() as c:
            names = {t.name for t in (await c.list_tools()).tools}
        for word in ("setting", "login", "logout", "auth", "chatgpt", "backend"):
            self.assertFalse([n for n in names if word in n], word)
        for word in ("shell", "exec", "file", "url", "fetch"):
            self.assertFalse([n for n in names if word in n], word)


class ParityTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    """The MCP tools and the HTTP routes reach the same service and the same data."""

    def setUp(self):
        super().setUp()
        self.put_doc(DOC_ID)
        self.http = TestClient(main.app, raise_server_exceptions=False)

    async def call(self, c, name, **args):
        return await c.call_tool(name, args)

    async def test_summary_is_shared_through_the_same_cache(self):
        with patch("app.ai.summarize", new=AsyncMock(return_value="S")) as gen:
            async with _client() as c:
                r = await self.call(c, "summarize", doc_id=DOC_ID)
            http = self.http.post("/api/summarize", json={"doc_id": DOC_ID})
        self.assertFalse(r.is_error)
        self.assertEqual(r.structured_content, http.json())
        self.assertEqual(gen.await_count, 1)

    async def test_stream_events_match_http_in_order_and_replay_from_cache(self):
        async def stream(segs, lang, brief=""):
            for s in segs:
                yield f"번역 {s}"

        progress = []

        async def on_progress(value, total, message):
            progress.append((value, total, json.loads(message)))

        args = {"doc_id": DOC_ID, "page": 0, "segments": ["a", "b", "c"]}
        with (
            patch("app.ai.translate_stream", new=stream),
            patch("app.service._get_brief", new=AsyncMock(return_value="")),
        ):
            async with _client() as c:
                r = await c.call_tool(
                    "translate_stream", args, progress_callback=on_progress
                )
        events = r.structured_content["events"]
        self.assertEqual(
            events,
            [
                {"i": 0, "tr": "번역 a"},
                {"i": 1, "tr": "번역 b"},
                {"i": 2, "tr": "번역 c"},
            ],
        )
        self.assertEqual(progress, [(k + 1, 3, e) for k, e in enumerate(events)])

        def fail(*_a, **_k):
            raise AssertionError("cached batch must not call the model")

        with patch("app.ai.translate_stream", new=fail):
            lines = self.http.post("/api/translate_stream", json=args).text
        self.assertEqual([json.loads(x) for x in lines.splitlines()], events)

    async def test_stream_failure_is_an_in_band_event_like_http(self):
        async def stream(segs, lang, brief=""):
            yield "가"
            raise RateLimitError("Subscription usage limit reached; try again later")

        args = {"doc_id": DOC_ID, "page": 0, "segments": ["a", "b"]}
        with (
            patch("app.ai.translate_stream", new=stream),
            patch("app.service._get_brief", new=AsyncMock(return_value="")),
        ):
            async with _client() as c:
                r = await c.call_tool("translate_stream", args)
            http = self.http.post("/api/translate_stream", json=args).text
        self.assertEqual(
            r.structured_content["events"],
            [json.loads(x) for x in http.splitlines()],
        )
        self.assertTrue(r.structured_content["events"][-1]["rate_limited"])
        self.assertFalse(any(p.name.startswith("tr_") for p in store.CACHE.rglob("*")))

    async def test_chat_history_is_one_history(self):
        with patch("app.ai.chat", new=AsyncMock(side_effect=["A1", "A2"])):
            async with _client() as c:
                r = await self.call(c, "chat", doc_id=DOC_ID, question="Q1")
                self.http.post("/api/chat", json={"doc_id": DOC_ID, "question": "Q2"})
                turns = await self.call(c, "chat_history", doc_id=DOC_ID)
                self.assertEqual(r.structured_content, {"answer": "A1"})
                self.assertEqual(
                    turns.structured_content,
                    self.http.get(f"/api/chat/{DOC_ID}").json(),
                )
                self.assertEqual(
                    [t["text"] for t in turns.structured_content["turns"]],
                    ["Q1", "A1", "Q2", "A2"],
                )
                await self.call(c, "chat_reset", doc_id=DOC_ID)
        self.assertEqual(self.http.get(f"/api/chat/{DOC_ID}").json(), {"turns": []})

    async def test_errors_carry_the_http_status_and_detail(self):
        cases = [
            ("summarize", {"doc_id": "fedcba9876543210"}, "/api/summarize", None),
            (
                "summarize",
                {"doc_id": DOC_ID, "output_language": "xx-nope"},
                "/api/summarize",
                None,
            ),
            ("summarize", {"doc_id": DOC_ID}, "/api/summarize", RateLimitError("lim")),
            ("summarize", {"doc_id": DOC_ID}, "/api/summarize", AIError("failed")),
            ("anatomy", {"doc_id": DOC_ID}, "/api/anatomy", AIError("bad json")),
        ]
        for tool, args, route, exc in cases:
            with self.subTest(tool=tool, args=args, exc=exc):
                fn = AsyncMock(side_effect=exc)
                with patch(f"app.ai.{tool}", new=fn):
                    async with _client() as c:
                        r = await c.call_tool(tool, args)
                    http = self.http.post(route, json=args)
                body = http.json()
                self.assertTrue(r.is_error)
                self.assertEqual(r.structured_content["status"], http.status_code)
                self.assertEqual(r.structured_content["detail"], body["detail"])
                self.assertEqual(r.content[0].text, body["detail"])
                self.assertEqual(
                    r.structured_content["rate_limited"],
                    body.get("rate_limited", False),
                )

    async def test_unexpected_errors_do_not_leak_their_text(self):
        secret = f"stderr: token={secrets.token_urlsafe()} /Users/someone/paper.pdf"
        with patch("app.ai.summarize", new=AsyncMock(side_effect=OSError(secret))):
            async with _client() as c:
                r = await self.call(c, "summarize", doc_id=DOC_ID)
        self.assertTrue(r.is_error)
        self.assertNotIn("token", r.content[0].text)
        self.assertNotIn("/Users", r.content[0].text)

    async def test_invalid_input_is_rejected_before_the_core(self):
        bad = [
            ("summarize", {"doc_id": "../../etc/passwd"}),
            ("summarize", {}),
            ("page_layout", {"doc_id": DOC_ID, "page": -1}),
            ("translate_stream", {"doc_id": DOC_ID, "page": "one"}),
            ("open_zotero_paper", {"item": "../x", "attachment": "ABCD1234"}),
        ]
        with patch("app.service.summarize", new=AsyncMock()) as core:
            async with _client() as c:
                for tool, args in bad:
                    with self.subTest(tool=tool, args=args):
                        r = await c.call_tool(tool, args)
                        self.assertTrue(r.is_error)
                        self.assertIsNone(r.structured_content)
        core.assert_not_awaited()

    async def test_folder_paths_cannot_escape_the_library(self):
        async with _client() as c:
            r = await self.call(c, "open_paper", rel="../../etc/passwd")
        self.assertEqual(r.structured_content["status"], 400)

    async def test_pdf_chunks_are_the_same_source_as_http(self):
        store.save_pdf(DOC_ID, b"%PDF-1.4 synthetic")
        async with _client() as c:
            res = await self.call(c, "pdf_chunk", doc_id=DOC_ID)
            missing = await self.call(c, "pdf_chunk", doc_id="fedcba9876543210")
        self.assertTrue(missing.is_error)
        blob = base64.b64decode(res.structured_content["data_base64"])
        self.assertEqual(blob, self.http.get(f"/api/pdf/{DOC_ID}").content)
        self.assertEqual(res.structured_content["total"], len(blob))

    async def test_review_bundle_is_the_same_zip(self):
        with patch(
            "app.service.write_review_bundle", new=_writes(b"PK zip", "a-paper")
        ):
            async with _client() as c:
                r = await self.call(c, "review", doc_id=DOC_ID)
                chunk = await self.call(
                    c, "review_chunk", download_id=r.structured_content["download_id"]
                )
                await self.call(
                    c, "release_review", download_id=r.structured_content["download_id"]
                )
            http = self.http.post(f"/api/review/{DOC_ID}")
        body = r.structured_content
        self.assertEqual(
            {k: body[k] for k in ("slug", "filename", "size")},
            {"slug": "a-paper", "filename": "a-paper.zip", "size": 6},
        )
        self.assertEqual(
            base64.b64decode(chunk.structured_content["data_base64"]), http.content
        )
        self.assertIn('filename="a-paper.zip"', http.headers["content-disposition"])

    async def test_pdf_chunks_reassemble_the_http_pdf(self):
        data = bytes(range(256)) * 10
        store.save_pdf(DOC_ID, data)
        parts, offset = [], 0
        async with _client() as c:
            while True:
                r = await self.call(
                    c, "pdf_chunk", doc_id=DOC_ID, offset=offset, length=1000
                )
                body = r.structured_content
                self.assertEqual((body["offset"], body["total"]), (offset, len(data)))
                chunk = base64.b64decode(body["data_base64"])
                if not chunk:
                    break
                parts.append(chunk)
                offset += len(chunk)
            too_big = await self.call(
                c, "pdf_chunk", doc_id=DOC_ID, length=mcp_server.PDF_CHUNK_MAX + 1
            )
        self.assertEqual(b"".join(parts), self.http.get(f"/api/pdf/{DOC_ID}").content)
        self.assertTrue(too_big.is_error)

    async def test_reader_config_reads_settings_without_probing_or_saving(self):
        before = Path(os.environ["SUNDARK_SETTINGS"]).read_bytes()
        with (
            patch("app.ai.probe", new=AsyncMock()) as probe,
            patch("app.settings.save") as save,
        ):
            async with _client() as c:
                r = await self.call(c, "reader_config")
        config = r.structured_content
        self.assertEqual(config["backend"], "hermes")
        self.assertEqual(config["concurrency"]["hermes"], 8)
        self.assertEqual(set(config["models"]), {b["id"] for b in config["backends"]})
        probe.assert_not_awaited()
        save.assert_not_called()
        self.assertEqual(Path(os.environ["SUNDARK_SETTINGS"]).read_bytes(), before)
        self.assertNotIn("validated_chatgpt_identity", json.dumps(config))


class ReaderResourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_reader_is_the_web_reader_with_its_own_files_inlined(self):
        async with _client() as c:
            res = await c.read_resource(mcp_server.READER_URI)
        content = res.contents[0]
        html = content.text
        self.assertEqual(content.mime_type, "text/html;profile=mcp-app")
        self.assertNotIn('src="/', html)
        self.assertNotIn('href="/', html)
        self.assertLess(
            html.index("window.SUNDARK_MCP_APP = true"), html.index("<script>\n")
        )
        for name in ("transport.js", "app.js"):
            first = (mcp_server.WEB / name).read_text().strip().splitlines()[0]
            self.assertIn(first, html, name)
        csp = content.meta["ui"]["csp"]
        self.assertEqual(
            csp["resourceDomains"],
            ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        )


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HttpTransportTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    """Streamable HTTP on loopback: bearer auth, Host/Origin checks, nothing else served."""

    TOKEN = secrets.token_urlsafe(32)

    def setUp(self):
        super().setUp()
        self.put_doc(DOC_ID, DOC)
        self.port = _free_port()
        config = uvicorn.Config(
            mcp_server.http_app(self.TOKEN, self.port),
            host="127.0.0.1",
            port=self.port,
            log_level="warning",
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        while not self.server.started:
            time.sleep(0.02)
        self.url = f"http://127.0.0.1:{self.port}/mcp"

    def tearDown(self):
        self.server.should_exit = True
        self.thread.join(5)
        super().tearDown()

    def post(self, headers):
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "t", "version": "0"},
            },
        }
        return httpx.post(
            self.url,
            json=body,
            headers={"Accept": "application/json, text/event-stream", **headers},
        )

    async def test_unauthenticated_requests_are_refused(self):
        self.assertEqual(self.post({}).status_code, 401)
        wrong = {"Authorization": "Bearer nope"}
        self.assertEqual(self.post(wrong).status_code, 401)

    async def test_dns_rebinding_is_refused_even_with_the_token(self):
        auth = {"Authorization": f"Bearer {self.TOKEN}"}
        evil_host = {**auth, "Host": f"evil.example:{self.port}"}
        self.assertEqual(self.post(evil_host).status_code, 421)
        evil_origin = {**auth, "Origin": "http://evil.example"}
        self.assertEqual(self.post(evil_origin).status_code, 403)

    async def test_only_the_mcp_endpoint_is_served(self):
        auth = {"Authorization": f"Bearer {self.TOKEN}"}
        for path in ("/api/papers", "/api/config", "/"):
            r = httpx.get(f"http://127.0.0.1:{self.port}{path}", headers=auth)
            self.assertEqual(r.status_code, 404, path)

    async def test_authenticated_sdk_client_reaches_the_core(self):
        headers = {"Authorization": f"Bearer {self.TOKEN}"}
        async with httpx2.AsyncClient(headers=headers) as http:
            transport = streamable_http_client(self.url, http_client=http)
            async with Client(transport, cache=None) as c:
                r = await c.call_tool("layout_status", {"doc_id": DOC_ID})
        self.assertEqual(
            r.structured_content, {"done": 0, "num_pages": 1, "finished": False}
        )


class StdioTransportTests(unittest.IsolatedAsyncioTestCase):
    def test_startup_output_cannot_corrupt_the_stdio_protocol(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        server = Mock()
        with (
            patch.object(sys, "stdout", stdout),
            patch.object(sys, "stderr", stderr),
            patch.object(
                mcp_server,
                "_require_layout_model",
                side_effect=lambda: print("model startup"),
            ),
            patch.object(mcp_server, "build_server", return_value=server),
        ):
            mcp_server.main([])
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("model startup", stderr.getvalue())
        server.run.assert_called_once_with("stdio")

    def test_empty_http_token_is_generated_and_printed(self):
        stderr = io.StringIO()
        with (
            patch.dict(os.environ, {"SUNDARK_MCP_TOKEN": ""}),
            patch.object(sys, "stderr", stderr),
            patch.object(mcp_server, "_require_layout_model"),
            patch.object(mcp_server, "http_app") as http_app,
            patch.object(uvicorn, "run"),
        ):
            mcp_server.main(["--http"])
        token = http_app.call_args.args[0]
        self.assertTrue(token)
        self.assertIn(f"MCP bearer token: {token}", stderr.getvalue())

    async def test_stdio_server_lists_tools(self):
        # The real entry point also loads the layout model first; this checks only
        # that importing the core keeps stdout clean for the protocol.
        params = StdioServerParameters(
            command=sys.executable,
            args=["-c", "from app import mcp_server; mcp_server.build_server().run()"],
            cwd=str(ROOT),
            env={**os.environ, "PAPERS_DIR": str(ROOT / "papers")},
        )
        async with Client(params, cache=None) as c:
            names = {t.name for t in (await c.list_tools()).tools}
        self.assertIn("translate_stream", names)


if __name__ == "__main__":
    unittest.main()


class UploadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.uploads = mcp_server._Uploads()

    def tearDown(self):
        for key in list(self.uploads.sessions):
            self.uploads.discard(key)

    def begin(self, size=3):
        return self.uploads.begin("paper.pdf", size)["upload_id"]

    def chunk(self, key, data=b"pdf", offset=0):
        return self.uploads.chunk(key, offset, base64.b64encode(data).decode())

    async def test_complete_upload_delegates_same_service_and_consumes_id(self):
        key = self.begin()
        f = self.uploads.sessions[key].file
        self.assertEqual(self.chunk(key, b"p"), {"offset": 1, "received": 1})
        self.chunk(key, b"df", 1)
        meta = {"doc_id": DOC_ID, "num_pages": 1}
        with patch.object(
            mcp_server.service, "upload_paper", AsyncMock(return_value=meta)
        ) as upload:
            self.assertEqual(await self.uploads.finish(key), meta)
            upload.assert_awaited_once_with("paper.pdf", b"pdf")
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                await self.uploads.finish(key)
            self.assertEqual(upload.await_count, 1)
        self.assertTrue(f.closed)

    async def test_partial_finish_and_service_error_clean_up(self):
        key = self.begin()
        f = self.uploads.sessions[key].file
        self.chunk(key, b"p")
        with patch.object(mcp_server.service, "upload_paper", AsyncMock()) as upload:
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                await self.uploads.finish(key)
            upload.assert_not_called()
        self.assertTrue(f.closed)
        key = self.begin()
        f = self.uploads.sessions[key].file
        self.chunk(key)
        with patch.object(
            mcp_server.service, "upload_paper", AsyncMock(side_effect=RuntimeError)
        ):
            with self.assertRaises(RuntimeError):
                await self.uploads.finish(key)
        self.assertTrue(f.closed)
        self.assertFalse(self.uploads.sessions)

    async def test_invalid_chunks_abort_without_ingestion(self):
        for offset, encoded in [
            (1, "cA=="),
            (0, "%%%"),
            (0, ""),
            (0, "cGRmWA=="),
            (0, base64.b64encode(b"x" * (mcp_server.PDF_CHUNK_MAX + 1)).decode()),
        ]:
            key = self.begin()
            f = self.uploads.sessions[key].file
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                self.uploads.chunk(key, offset, encoded)
            self.assertTrue(f.closed)
            self.assertNotIn(key, self.uploads.sessions)

    async def test_size_count_and_aggregate_bounds(self):
        for size in (0, -1, mcp_server.UPLOAD_MAX + 1):
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                self.begin(size)
        with self.assertRaises(mcp_server.service.InvalidRequestError):
            self.uploads.begin("paper.txt", 3)
        keys = [self.begin(mcp_server.UPLOAD_MAX) for _ in range(4)]
        self.assertEqual(len(set(keys)), 4)
        with self.assertRaises(mcp_server.service.InvalidRequestError):
            self.begin()
        self.uploads.cancel(keys.pop())
        with patch.object(
            mcp_server, "UPLOAD_AGGREGATE_MAX", mcp_server.UPLOAD_MAX * 3
        ):
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                self.begin()

    async def test_cancel_and_interrupted_upload_expiry(self):
        key = self.begin()
        f = self.uploads.sessions[key].file
        self.assertEqual(self.uploads.cancel(key), {"ok": True})
        self.assertEqual(self.uploads.cancel(key), {"ok": True})
        self.assertTrue(f.closed)
        key = self.begin()
        session = self.uploads.sessions[key]
        with patch.object(
            mcp_server.time, "monotonic", return_value=session.touched + 301
        ):
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                self.uploads.get(key)
        self.assertTrue(session.file.closed)
        with patch.object(mcp_server, "UPLOAD_TTL", 0):
            key = self.begin()
            f = self.uploads.sessions[key].file
            await asyncio.sleep(0.01)
        self.assertTrue(f.closed)
        self.assertNotIn(key, self.uploads.sessions)

    async def test_mcp_upload_contract(self):
        with patch.object(
            mcp_server.service,
            "upload_paper",
            AsyncMock(return_value={"doc_id": DOC_ID}),
        ) as upload:
            async with _client() as c:
                result = await c.call_tool(
                    "begin_upload", {"filename": "paper.pdf", "size": 3}
                )
                key = result.structured_content["upload_id"]
                result = await c.call_tool(
                    "upload_chunk",
                    {"upload_id": key, "offset": 0, "data_base64": "cGRm"},
                )
                self.assertEqual(
                    result.structured_content, {"offset": 3, "received": 3}
                )
                result = await c.call_tool("finish_upload", {"upload_id": key})
                self.assertEqual(result.structured_content, {"doc_id": DOC_ID})
                result = await c.call_tool("finish_upload", {"upload_id": key})
                self.assertTrue(result.is_error)
                self.assertEqual(result.structured_content["status"], 400)
            upload.assert_awaited_once_with("paper.pdf", b"pdf")


class UploadValidationTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    async def test_invalid_pdf_uses_existing_service_validation(self):
        uploads = mcp_server._Uploads()
        key = uploads.begin("invalid.pdf", 3)["upload_id"]
        uploads.chunk(key, 0, "cGRm")
        with self.assertRaises(mcp_server.service.InvalidRequestError):
            await uploads.finish(key)
        self.assertFalse(uploads.sessions)
        self.assertEqual(list(store.DOCS.iterdir()), [])
        self.assertEqual(list(store.PDFS.iterdir()), [])

    async def test_chat_history_runs_off_event_loop_in_both_transports(self):
        loop_thread = threading.get_ident()
        self.put_doc(DOC_ID)
        calls = []

        def history(doc_id):
            calls.append(threading.get_ident())
            return [{"role": "user", "text": "retained"}]

        with patch.object(mcp_server.service, "chat_history", side_effect=history):
            async with _client() as c:
                result = await c.call_tool("chat_history", {"doc_id": DOC_ID})
            self.assertEqual(result.structured_content["turns"][0]["text"], "retained")
            result = await main.chat_history(DOC_ID)
            self.assertEqual(result["turns"][0]["text"], "retained")
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(t != loop_thread for t in calls))


class UploadConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_finishing_retains_capacity_and_cancellation_cleans_up(self):
        uploads = mcp_server._Uploads()
        key = uploads.begin("paper.pdf", 3)["upload_id"]
        uploads.chunk(key, 0, "cGRm")
        f = uploads.sessions[key].file
        entered = asyncio.Event()
        release = asyncio.Event()

        async def ingest(filename, data):
            entered.set()
            await release.wait()

        with patch.object(mcp_server.service, "upload_paper", side_effect=ingest):
            task = asyncio.create_task(uploads.finish(key))
            await entered.wait()
            try:
                with self.assertRaises(mcp_server.service.InvalidRequestError):
                    await uploads.finish(key)
                with self.assertRaises(mcp_server.service.InvalidRequestError):
                    uploads.cancel(key)
                with patch.object(mcp_server, "UPLOAD_ACTIVE_MAX", 1):
                    with self.assertRaises(mcp_server.service.InvalidRequestError):
                        uploads.begin("next.pdf", 1)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        self.assertTrue(f.closed)
        self.assertFalse(uploads.sessions)


class ReviewTransferTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.reviews = mcp_server._Reviews()

    def tearDown(self):
        for key in list(self.reviews.sessions):
            self.reviews.discard(key)

    async def generate(self, data=b"PK zip"):
        with patch.object(mcp_server.service, "write_review_bundle", _writes(data)):
            return await self.reviews.generate(DOC_ID, None)

    async def test_large_zip_roundtrip_generates_once(self):
        data = b"PK" + bytes(range(256)) * 8192
        with patch.object(
            mcp_server.service, "write_review_bundle", _writes(data)
        ) as gen:
            async with _client() as c:
                result = await c.call_tool("review", {"doc_id": DOC_ID})
                meta = result.structured_content
                self.assertEqual(meta["size"], len(data))
                self.assertNotIn("data_base64", meta)
                chunks = []
                for offset in range(0, len(data), mcp_server.PDF_CHUNK_MAX):
                    result = await c.call_tool(
                        "review_chunk",
                        {
                            "download_id": meta["download_id"],
                            "offset": offset,
                            "length": mcp_server.PDF_CHUNK_MAX,
                        },
                    )
                    chunk = result.structured_content
                    self.assertEqual(
                        (chunk["offset"], chunk["total"]), (offset, len(data))
                    )
                    chunks.append(base64.b64decode(chunk["data_base64"]))
                self.assertEqual(b"".join(chunks), data)
                for _ in range(2):
                    result = await c.call_tool(
                        "release_review", {"download_id": meta["download_id"]}
                    )
                    self.assertEqual(result.structured_content, {"ok": True})
                result = await c.call_tool(
                    "review_chunk", {"download_id": meta["download_id"]}
                )
                self.assertTrue(result.is_error)
            gen.assert_awaited_once()
            self.assertEqual(gen.call_args.args[:2], (DOC_ID, None))

    async def test_file_count_aggregate_bounds_and_errors(self):
        with (
            patch.object(mcp_server, "REVIEW_MAX", 3),
            patch.object(mcp_server, "REVIEW_AGGREGATE_MAX", 12),
        ):
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                await self.generate(b"1234")
            self.assertFalse(self.reviews.sessions)
            ids = [(await self.generate(b"123"))["download_id"] for _ in range(4)]
            with patch.object(
                mcp_server.service, "write_review_bundle", AsyncMock()
            ) as gen:
                with self.assertRaises(mcp_server.service.InvalidRequestError):
                    await self.reviews.generate(DOC_ID, None)
                gen.assert_not_called()
            self.reviews.discard(ids.pop())
            with patch.object(mcp_server, "REVIEW_AGGREGATE_MAX", 9):
                with self.assertRaises(mcp_server.service.InvalidRequestError):
                    await self.generate(b"1")
        for key in list(self.reviews.sessions):
            self.reviews.discard(key)
        with patch.object(
            mcp_server.service,
            "write_review_bundle",
            AsyncMock(side_effect=RuntimeError),
        ):
            with self.assertRaises(RuntimeError):
                await self.reviews.generate(DOC_ID, None)
        self.assertFalse(self.reviews.sessions)

    async def test_bundle_is_bounded_while_it_is_written(self):
        sizes = []

        async def write(doc_id, language, out):
            out.write(b"12")
            try:
                out.write(b"34")
            finally:
                sizes.append(out.file.tell())
            out.write(b"")  # refused for good once over the limit

        with (
            patch.object(mcp_server, "REVIEW_MAX", 3),
            patch.object(
                mcp_server.service,
                "write_review_bundle",
                AsyncMock(side_effect=write),
            ),
        ):
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                await self.reviews.generate(DOC_ID, None)
        self.assertEqual(sizes, [2])  # the file never held more than the limit
        self.assertFalse(self.reviews.sessions)

    def test_a_real_zip_streams_through_the_bounded_writer(self):
        with tempfile.TemporaryFile() as f:
            out = mcp_server._BoundedWriter(f, 1 << 20)
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("p/index.md", "# note\n")
                z.writestr("p/fig1.png", os.urandom(4096))
            f.seek(0)
            self.assertEqual(len(f.read()), out.size)
            f.seek(0)
            with zipfile.ZipFile(f) as z:
                self.assertEqual(z.read("p/index.md"), b"# note\n")
        with tempfile.TemporaryFile() as f:
            out = mcp_server._BoundedWriter(f, 2048)
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
                    z.writestr("p/fig1.png", os.urandom(4096))
            self.assertLessEqual(f.seek(0, 2), 2048)

    async def test_invalid_ranges_expiry_and_release_close_files(self):
        for offset, length in [
            (-1, 1),
            (7, 1),
            (0, 0),
            (0, mcp_server.PDF_CHUNK_MAX + 1),
        ]:
            key = (await self.generate())["download_id"]
            f = self.reviews.sessions[key].file
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                self.reviews.read(key, offset, length)
            self.assertTrue(f.closed)
        key = (await self.generate())["download_id"]
        session = self.reviews.sessions[key]
        with patch.object(
            mcp_server.time, "monotonic", return_value=session.touched + 301
        ):
            with self.assertRaises(mcp_server.service.InvalidRequestError):
                self.reviews.read(key, 0, 1)
        self.assertTrue(session.file.closed)
        key = (await self.generate())["download_id"]
        f = self.reviews.sessions[key].file
        self.reviews.discard(key)
        self.assertTrue(f.closed)

    async def test_shutdown_closes_upload_and_review_files(self):
        files = []
        original = mcp_server.tempfile.TemporaryFile

        def temporary_file(*args, **kwargs):
            f = original(*args, **kwargs)
            files.append(f)
            return f

        with (
            patch.object(
                mcp_server.tempfile, "TemporaryFile", side_effect=temporary_file
            ),
            patch.object(mcp_server.service, "write_review_bundle", _writes(b"PK")),
        ):
            async with _client() as c:
                await c.call_tool("begin_upload", {"filename": "paper.pdf", "size": 3})
                await c.call_tool("review", {"doc_id": DOC_ID})
                self.assertEqual(len(files), 2)
                self.assertTrue(all(not f.closed for f in files))
            self.assertTrue(all(f.closed for f in files))
