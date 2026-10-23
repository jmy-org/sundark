"""The opt-in Site companion (`python -m app.mcp_server --http --site-origin ...`): one exact
origin, the bearer on every request, a bounded tool set scoped to its own uploads."""

import base64
import secrets
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import uvicorn
from fastapi.testclient import TestClient
from mcp import Client

from app import main, mcp_server, service
from tests.pdfgen import make_pdf
from tests.test_mcp_server import DOC_ID, _free_port
from tests.test_service import DOC, _StoreDirs

SITE = "https://sundark-research-library.keenranger.chatgpt.site"


def _site_client() -> Client:
    return Client(mcp_server.build_server(site_origin=SITE), cache=None)


async def _upload(c: Client, pdf: bytes) -> dict:
    key = (
        await c.call_tool("begin_upload", {"filename": "paper.pdf", "size": len(pdf)})
    ).structured_content["upload_id"]
    await c.call_tool(
        "upload_chunk",
        {"upload_id": key, "offset": 0, "data_base64": base64.b64encode(pdf).decode()},
    )
    return (await c.call_tool("finish_upload", {"upload_id": key})).structured_content


class OriginTests(unittest.TestCase):
    def test_exact_https_origins_are_accepted(self):
        for value in (SITE, "https://a.example", "https://a.example:8443"):
            self.assertEqual(mcp_server.site_origin(value), value)

    def test_anything_looser_is_refused(self):
        for value in (
            "",
            "*",
            "null",
            "http://a.example",
            "https://*.example",
            "https://a*.example",
            "https://*",
            "https://a.example/",
            "https://a.example/path",
            "https://a.example?x=1",
            "https://a.example#x",
            "https://a.example:443",
            "https://a.example:0",
            "https://a.example:99999",
            "https://a.example:x",
            "https://user@a.example",
            "https://A.example",
            "https://-a.example",
            "https://localhost",
            "https://127.0.0.1",
            "https://[::1]",
            f"{SITE} ",
        ):
            with self.assertRaises(ValueError, msg=value):
                mcp_server.site_origin(value)

    def test_cli_refuses_a_bad_origin_or_one_without_http(self):
        with (
            patch.object(mcp_server, "_require_layout_model"),
            patch.object(mcp_server, "http_app") as http_app,
            patch.object(uvicorn, "run"),
            patch("sys.stderr"),
        ):
            for argv in (
                ["--site-origin", SITE],
                ["--http", "--site-origin", "https://*.example"],
                ["--http", "--site-origin", SITE, "--port", "80"],
            ):
                with self.assertRaises(SystemExit, msg=argv):
                    mcp_server.main(argv)
            http_app.assert_not_called()
            mcp_server.main(["--http", "--site-origin", SITE])
        self.assertEqual(http_app.call_args.args[2], SITE)


class ToolScopeTests(_StoreDirs, unittest.IsolatedAsyncioTestCase):
    async def test_only_the_site_tools_exist(self):
        async with _site_client() as c:
            names = {t.name for t in (await c.list_tools()).tools}
            resources = (await c.list_resources()).resources
        self.assertEqual(names, set(mcp_server.SITE_TOOLS))
        self.assertEqual(resources, [])

    async def test_a_paper_it_did_not_ingest_is_unknown(self):
        self.put_doc(DOC_ID, DOC)  # opened locally, e.g. from the library
        with (
            patch.object(service, "summarize", AsyncMock()) as summarize,
            patch.object(service, "page_layout", AsyncMock()) as layout,
        ):
            async with _site_client() as c:
                for name, args in (
                    ("layout_status", {}),
                    ("page_layout", {"page": 0}),
                    ("summarize", {}),
                    ("anatomy", {}),
                    ("translate_page", {"page": 0}),
                ):
                    r = await c.call_tool(name, {"doc_id": DOC_ID, **args})
                    self.assertTrue(r.is_error, name)
                    self.assertEqual(r.structured_content["status"], 404, name)
        summarize.assert_not_awaited()
        layout.assert_not_awaited()

    async def test_its_own_upload_is_reachable_and_stays_out_of_the_library(self):
        pdf = make_pdf(["A Paper Title\nSome body text."])
        with (
            patch("app.biblio.lookup", new=AsyncMock(return_value=None)),
            patch("app.service.schedule_prewarm", side_effect=lambda m: m),
        ):
            async with _site_client() as c:
                meta = await _upload(c, pdf)
                r = await c.call_tool("layout_status", {"doc_id": meta["doc_id"]})
            self.assertFalse(r.is_error)
            self.assertEqual(r.structured_content["num_pages"], 1)
            # A second companion (a new pairing) does not inherit the first one's papers.
            async with _site_client() as c:
                r = await c.call_tool("layout_status", {"doc_id": meta["doc_id"]})
            self.assertTrue(r.is_error)
        self.assertEqual(list(service.PAPERS_DIR.iterdir()), [])

    async def test_default_server_is_unchanged(self):
        async with Client(mcp_server.build_server(), cache=None) as c:
            names = {t.name for t in (await c.list_tools()).tools}
        self.assertLess(set(mcp_server.SITE_TOOLS), names)
        self.assertIn("list_papers", names)


class HttpTests(_StoreDirs, unittest.TestCase):
    TOKEN = secrets.token_urlsafe(32)

    def setUp(self):
        super().setUp()
        self.port = _free_port()
        self.host = f"127.0.0.1:{self.port}"
        self.url = f"http://{self.host}/mcp"
        self.server = uvicorn.Server(
            uvicorn.Config(
                mcp_server.http_app(self.TOKEN, self.port, SITE),
                host="127.0.0.1",
                port=self.port,
                log_level="warning",
            )
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        while not self.server.started:
            time.sleep(0.02)

    def tearDown(self):
        self.server.should_exit = True
        self.thread.join(5)
        super().tearDown()

    def preflight(self, url=None, **headers):
        base = {
            "Origin": SITE,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
        }
        return httpx.options(url or self.url, headers={**base, **headers})

    def post(self, **headers):
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

    def test_preflight_from_the_site_is_answered_exactly(self):
        r = self.preflight()
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.headers["access-control-allow-origin"], SITE)
        self.assertEqual(r.headers["access-control-allow-methods"], "GET, POST, DELETE")
        self.assertNotIn("access-control-allow-credentials", r.headers)
        self.assertNotIn("access-control-allow-private-network", r.headers)
        self.assertEqual(r.content, b"")
        r = self.preflight(**{"Access-Control-Request-Private-Network": "true"})
        self.assertEqual(r.headers["access-control-allow-private-network"], "true")

    def test_any_other_preflight_is_refused_without_cors_headers(self):
        cases = [
            {"Origin": "https://evil.example"},
            {"Origin": "null"},
            {"Origin": SITE + "/"},
            {"Origin": SITE.replace("https", "http")},
            {"Origin": SITE + ":8443"},
            {"Host": f"evil.example:{self.port}"},
            {"Host": f"localhost:{self.port}"},
            {"Access-Control-Request-Method": "PUT"},
            {"Access-Control-Request-Headers": "authorization, x-extra"},
        ]
        for headers in cases:
            r = self.preflight(**headers)
            self.assertEqual(r.status_code, 403, headers)
            self.assertNotIn("access-control-allow-origin", r.headers, headers)
        r = self.preflight(f"http://{self.host}/api/papers")
        self.assertEqual(r.status_code, 403)

    def test_the_token_is_required_with_or_without_an_origin(self):
        for headers in ({}, {"Origin": SITE}, {"Authorization": "Bearer nope"}):
            self.assertEqual(self.post(**headers).status_code, 401, headers)
        # The Site can read the refusal (to say the token is wrong), nothing more.
        r = self.post(Origin=SITE)
        self.assertEqual(r.headers["access-control-allow-origin"], SITE)

    def test_the_site_reaches_the_core_with_the_token(self):
        auth = {"Authorization": f"Bearer {self.TOKEN}"}
        r = self.post(Origin=SITE, **auth)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], SITE)
        self.assertEqual(r.headers["access-control-expose-headers"], "mcp-session-id")
        self.assertTrue(r.headers["mcp-session-id"])
        r = self.post(**auth)  # a local client without an Origin, as before
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_foreign_origin_or_host_is_refused_even_with_the_token(self):
        auth = {"Authorization": f"Bearer {self.TOKEN}"}
        r = self.post(Origin="https://evil.example", **auth)
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("access-control-allow-origin", r.headers)
        self.assertEqual(
            self.post(Host=f"evil.example:{self.port}", **auth).status_code, 421
        )

    def test_request_bodies_are_bounded(self):
        r = httpx.post(
            self.url,
            content=b"x" * (mcp_server.SITE_BODY_MAX + 1),
            headers={
                "Authorization": f"Bearer {self.TOKEN}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
        )
        self.assertEqual(r.status_code, 413)


class UnchangedSurfacesTests(_StoreDirs, unittest.TestCase):
    def test_reader_http_api_sends_no_cors_headers(self):
        client = TestClient(main.app)
        r = client.options(
            "/api/papers",
            headers={"Origin": SITE, "Access-Control-Request-Method": "GET"},
        )
        self.assertNotIn("access-control-allow-origin", r.headers)
        r = client.get("/api/papers", headers={"Origin": SITE})
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_default_http_app_has_no_cors(self):
        app = mcp_server.http_app("t", 8744)
        self.assertNotIsInstance(app, mcp_server._SiteCors)


if __name__ == "__main__":
    unittest.main()
