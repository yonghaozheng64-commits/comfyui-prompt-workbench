import asyncio
import json

from aiohttp import web
from server import PromptServer

from .backend.queue_status import collect_status

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"
__version__ = "0.2.0"


@PromptServer.instance.routes.post("/prompt-workbench/batch-status")
async def prompt_workbench_batch_status(request):
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return web.json_response({"error": "Expected a JSON object"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "Expected a JSON object"}, status=400)
    for field in ("prompt_ids", "signatures"):
        values = payload.get(field, [])
        if not isinstance(values, list) or len(values) > 10000:
            return web.json_response({"error": f"{field} must be a list of at most 10000 items"}, status=400)
    result = await asyncio.to_thread(collect_status, PromptServer.instance.prompt_queue, payload)
    return web.json_response(result)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
