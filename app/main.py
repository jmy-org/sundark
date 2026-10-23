"""Sundark — FastAPI backend.

Personal, local tool. Serves the static reader UI and a small JSON API using
the selected subscription backend, including ChatGPT sign-in, for AI tasks.
The use cases live in `app/service.py`; this module maps HTTP onto them.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, StrictBool

from . import (
    ai,
    backends,
    layout_model,
    pdf_utils,
    service,
    settings,
    zotero,
)
from .backends import chatgpt_auth
from .errors import AIError, RateLimitError

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


class _ChatGPTCallbackLogFilter(logging.Filter):
    """Uvicorn logs the query string after the response; redact OAuth callbacks."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) == 5:
            args = list(record.args)
            if (
                isinstance(args[2], str)
                and args[2].split("?", 1)[0] == "/api/chatgpt/callback"
            ):
                args[2] = "/api/chatgpt/callback"
                record.args = tuple(args)
        return True


logging.getLogger("uvicorn.access").addFilter(_ChatGPTCallbackLogFilter())


app = FastAPI(title="Sundark")


@app.exception_handler(AIError)
async def _ai_error(_request: Request, exc: AIError):
    limited = isinstance(exc, RateLimitError)
    return JSONResponse(
        status_code=429 if limited else 502,
        content={"detail": str(exc), "rate_limited": limited},
    )


@app.exception_handler(service.NotFoundError)
async def _not_found(_request: Request, exc: service.NotFoundError):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(service.InvalidRequestError)
async def _invalid_request(_request: Request, exc: service.InvalidRequestError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(zotero.ZoteroError)
async def _zotero_down(_request: Request, exc: zotero.ZoteroError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.on_event("startup")
async def _warm_layout_model() -> None:
    """BLOCK startup until the layout model is loaded (it downloads on first run). Uvicorn only
    reports "Application startup complete" — and only then accepts requests — once this returns,
    so the homepage is reachable only after the model is ready and the first paper opens without
    waiting on it. The layout model is REQUIRED: region typing has no heuristic fallback, so if
    it can't load we fail startup with a clear message instead of serving a broken parser."""
    print("Loading models (first run downloads them)…", flush=True)
    ready = await asyncio.to_thread(layout_model.available)
    if not ready:
        raise RuntimeError(
            "Layout model (DocLayout-YOLO) failed to load. It is required — the parser has no "
            "heuristic fallback. Check the torch/torchvision install (both from the SAME index) "
            "and that the model can download, then restart. See AGENTS.md."
        )
    print("Layout model ready.", flush=True)
    seg = await asyncio.to_thread(pdf_utils.warm_sentence_model)
    print(
        "Sentence model ready." if seg else "Sentence model unavailable — using pysbd.",
        flush=True,
    )


@app.get("/api/papers")
async def papers():
    """List PDF files in the papers folder, newest first, titled when possible."""
    return service.list_papers()


class OpenReq(BaseModel):
    rel: str


@app.post("/api/open")
async def open_paper(req: OpenReq):
    """Open a paper from the papers folder by its relative path."""
    return await service.open_folder_paper(req.rel)


# --- Zotero (read-only, through Zotero's local API; a down Zotero becomes HTTP 503) ---


@app.get("/api/zotero/status")
async def zotero_status():
    return {"available": await asyncio.to_thread(zotero.available)}


@app.get("/api/zotero/collections")
async def zotero_collections():
    return {"collections": await asyncio.to_thread(zotero.collections)}


@app.get("/api/zotero/items")
async def zotero_items(
    collection: str | None = None, q: str | None = None, start: int = 0
):
    return await asyncio.to_thread(
        zotero.items, collection=collection, q=q, start=start
    )


class ZoteroOpenReq(BaseModel):
    item: str
    attachment: str


@app.post("/api/zotero/open")
async def zotero_open(req: ZoteroOpenReq):
    """Open a Zotero PDF where it is (no copy into papers/)."""
    return await service.open_zotero_paper(req.item, req.attachment)


@app.get("/api/status/{doc_id}")
async def status(doc_id: str):
    """Layout pre-warm progress for the loading bar: {done, num_pages, finished}."""
    return service.layout_status(doc_id)


@app.get("/api/layout/{doc_id}/{page}")
async def layout(doc_id: str, page: int):
    """Word-level geometry + sentence grouping for one page (cached)."""
    return await service.page_layout(doc_id, page)


@app.get("/api/math/{doc_id}/{page}")
async def math(doc_id: str, page: int):
    """LaTeX for each display equation on a page (cached per page/model)."""
    return await service.page_math(doc_id, page)


@app.get("/api/pdf/{doc_id}")
async def get_pdf(doc_id: str):
    return FileResponse(service.pdf_path(doc_id), media_type="application/pdf")


@app.post("/api/upload")
async def upload(file: UploadFile):
    return await service.upload_paper(file.filename or "", await file.read())


class SummarizeReq(BaseModel):
    doc_id: str
    output_language: str | None = None


@app.post("/api/summarize")
async def summarize(req: SummarizeReq):
    return await service.summarize(req.doc_id, req.output_language)


class AnatomyReq(BaseModel):
    doc_id: str
    output_language: str | None = None
    force: bool = False


@app.post("/api/anatomy")
async def anatomy(req: AnatomyReq):
    try:
        return await service.anatomy(req.doc_id, req.output_language, req.force)
    except RateLimitError:
        raise
    except AIError as e:
        raise HTTPException(502, f"분석 실패: {e}") from e


@app.post("/api/review/{doc_id}")
async def review_export(doc_id: str, output_language: str | None = None):
    """Generate the review note and return it as a zipped Hugo page bundle."""
    slug, data = await service.review_bundle(doc_id, output_language)
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{slug}.zip"'},
    )


class TranslateReq(BaseModel):
    doc_id: str
    page: int  # 0-indexed
    target_lang: str | None = None
    segments: list[str] | None = (
        None  # client-supplied segments (from the PDF text layer)
    )
    force: bool = False  # re-translate, ignoring any cached result


@app.post("/api/translate")
async def translate(req: TranslateReq):
    return await service.translate(req.doc_id, req.page, req.target_lang, req.segments)


async def _ndjson(events):
    try:
        async for event in events:
            yield json.dumps(event, ensure_ascii=False) + "\n"
    finally:
        await events.aclose()


@app.post("/api/translate_stream")
async def translate_stream(req: TranslateReq):
    """Progressive translation: streams one NDJSON line {"i":k,"tr":"..."} per segment
    as the model produces it, so sentences appear from the top instead of all at once."""
    events = service.translate_stream(
        req.doc_id, req.page, req.target_lang, req.segments, req.force
    )
    return StreamingResponse(_ndjson(events), media_type="application/x-ndjson")


class ExplainReq(BaseModel):
    doc_id: str
    output_language: str | None = None
    text: str


@app.post("/api/explain")
async def explain(req: ExplainReq):
    explanation = await service.explain(req.doc_id, req.text, req.output_language)
    return {"explanation": explanation}


class ChatReq(BaseModel):
    doc_id: str
    output_language: str | None = None
    question: str


@app.post("/api/chat")
async def chat(req: ChatReq):
    answer = await service.chat(req.doc_id, req.question, req.output_language)
    return {"answer": answer}


@app.get("/api/chat/{doc_id}")
async def chat_history(doc_id: str):
    return {"turns": await asyncio.to_thread(service.chat_history, doc_id)}


@app.post("/api/chat/{doc_id}/reset")
async def chat_reset(doc_id: str):
    # The reset takes a short file lock; keep it off the event loop.
    await asyncio.to_thread(service.chat_reset, doc_id)
    return {"ok": True}


class BriefReq(BaseModel):
    doc_id: str
    target_lang: str | None = None


@app.post("/api/brief")
async def brief(req: BriefReq):
    """Warm (or return) the cached translation glossary for a paper."""
    return {"brief": await service.brief(req.doc_id, req.target_lang)}


async def _backend_rows() -> list[dict]:
    rows = []
    for name, mod in backends.BACKENDS.items():
        provider = None
        ready = mod.installed()
        if name == "chatgpt":
            try:
                ready = chatgpt_auth.status()["ready"]
            except AIError:
                ready = False
        if mod.installed():
            try:
                # describe() may start a subprocess (Hermes); keep it off the event loop.
                provider = (await asyncio.to_thread(mod.describe)).get("provider")
            except AIError:
                provider = None
        rows.append(
            {
                "id": name,
                "label": mod.LABEL,
                "installed": mod.installed(),
                "provider": provider,
                "suggestions": mod.MODEL_SUGGESTIONS,
                "ready": ready,
            }
        )
    return rows


async def _first_run_backend(rows: list[dict]) -> tuple[str | None, str | None]:
    installed = [r["id"] for r in rows if r.get("ready", r["installed"])]
    if not installed:
        return (
            None,
            "Connect ChatGPT in Settings, or install Claude Code or Hermes and sign in.",
        )
    if len(installed) > 1:
        return None, "Choose an AI Backend in Settings."
    name = installed[0]
    s = settings.load()
    try:
        await ai.probe(name, settings.model_for(s, name, "translate"))
    except AIError as exc:
        return None, f"{backends.get(name).LABEL} is installed but not ready: {exc}"
    settings.save(name, {}, settings.concurrency_for(s, name))
    return name, None


@app.get("/api/config")
async def config():
    rows = await _backend_rows()
    s = settings.load()
    backend, reason = s["backend"], None
    if backend is None:
        backend, reason = await _first_run_backend(rows)
        s = settings.load()
    return {
        "backend": backend,
        "reason": reason,
        "backends": rows,
        "tasks": list(settings.TASKS),
        "models": s["models"],
        "default_models": settings.DEFAULT_MODELS,
        "output_language": s["output_language"],
        "output_languages": list(settings.OUTPUT_LANGUAGES),
        "concurrency": s["concurrency"],
    }


class SettingsReq(BaseModel):
    backend: str
    output_language: str | None = None
    models: dict[str, str] = {}
    concurrency: int = settings.DEFAULT_CONCURRENCY


@app.post("/api/settings")
async def save_settings(req: SettingsReq):
    language = service.output_language(req.output_language)
    if req.backend not in backends.BACKENDS:
        raise HTTPException(400, f"Unknown AI Backend: {req.backend}")
    try:
        settings.validate(req.backend, req.models, req.concurrency)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    current = settings.load()
    merged = {**current["models"][req.backend], **req.models}
    account = chatgpt_auth.validation_identity() if req.backend == "chatgpt" else None
    unchanged = (
        current["backend"] == req.backend
        and merged == current["models"][req.backend]
        and (
            req.backend != "chatgpt"
            or account is not None
            and account == current["validated_chatgpt_identity"]
        )
    )
    for model_id in [] if unchanged else sorted(set(merged.values())):
        try:
            await ai.probe(req.backend, model_id)
        except AIError as exc:
            raise HTTPException(400, f"{model_id}: {exc}") from exc
    if req.backend == "chatgpt" and chatgpt_auth.validation_identity() != account:
        raise HTTPException(409, "ChatGPT account changed; save settings again")
    try:
        settings.save(
            req.backend,
            req.models,
            req.concurrency,
            language,
            validated_chatgpt_identity=account,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


# ChatGPT credentials stay server-side; mutations accept only this local UI.
def _chatgpt_host(request: Request) -> None:
    if request.url.hostname != "127.0.0.1":
        raise HTTPException(400, "Open Sundark at http://127.0.0.1 to connect ChatGPT")


def _chatgpt_origin(request: Request) -> str:
    _chatgpt_host(request)
    origin = str(request.base_url).rstrip("/")
    if request.headers.get("origin") != origin:
        raise HTTPException(403, "ChatGPT account actions must start from Sundark")
    return origin


class ChatGPTAccountReq(BaseModel):
    account_id: str | None = None
    new_account: StrictBool = False


@app.get("/api/chatgpt/status")
async def chatgpt_status(request: Request):
    _chatgpt_host(request)
    return chatgpt_auth.status()


@app.get("/api/chatgpt/models")
async def chatgpt_models(request: Request):
    _chatgpt_host(request)
    return {"models": await chatgpt_auth.models()}


@app.post("/api/chatgpt/login")
async def chatgpt_login(request: Request, req: ChatGPTAccountReq):
    origin = _chatgpt_origin(request)
    return await chatgpt_auth.begin(
        origin + "/api/chatgpt/callback", req.account_id, new_account=req.new_account
    )


@app.get("/api/chatgpt/callback")
async def chatgpt_callback(request: Request):
    params = request.query_params
    try:
        await chatgpt_auth.complete(
            params.get("code"),
            params.get("state"),
            params.get("client_id"),
            error=params.get("error"),
        )
        message = "ChatGPT connected. Return to Sundark and refresh the account status."
    except AIError:
        message = "ChatGPT connection failed. Return to Sundark and try again."
    return HTMLResponse(
        "<!doctype html><html lang='en'><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width'>"
        "<title>ChatGPT connection</title><p role='status'>" + message + "</p></html>",
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        },
    )


@app.post("/api/chatgpt/select")
async def chatgpt_select(request: Request, req: ChatGPTAccountReq):
    _chatgpt_origin(request)
    await chatgpt_auth.select(req.account_id)
    return chatgpt_auth.status()


@app.post("/api/chatgpt/logout")
async def chatgpt_logout(request: Request, req: ChatGPTAccountReq):
    _chatgpt_origin(request)
    return await chatgpt_auth.logout(req.account_id)


# --- static UI (mounted last so /api/* wins) ---
@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
