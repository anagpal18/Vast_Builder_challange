"""W&B Inference client + Weave tracing. Degrades to deterministic templates when no key is set."""
import json
import logging
import re

from backend import config as C

log = logging.getLogger("almost.llm")

_weave = None
_client = None
WEAVE_URL = None


def init():
    """Call once at startup. Safe to call again."""
    global _weave, _client, WEAVE_URL
    if _client is not None or not C.WANDB_API_KEY:
        return
    project = f"{C.WANDB_ENTITY}/{C.WANDB_PROJECT}" if C.WANDB_ENTITY else C.WANDB_PROJECT
    try:
        import weave
        weave.init(project)
        _weave = weave
        if C.WANDB_ENTITY:
            WEAVE_URL = f"https://wandb.ai/{C.WANDB_ENTITY}/{C.WANDB_PROJECT}/weave"
    except Exception as e:  # tracing is optional; never block the demo on it
        log.warning("weave.init failed: %s", e)
    try:
        import openai
        _client = openai.OpenAI(base_url=C.WANDB_BASE_URL, api_key=C.WANDB_API_KEY, project=project,
                                timeout=45, max_retries=1)
    except Exception as e:
        log.warning("W&B Inference client unavailable: %s", e)


def enabled():
    return _client is not None


def op(fn=None, *, name=None):
    """@weave.op when Weave is available (resolved lazily, so decorating at import time is fine)."""
    def wrap(f):
        cache = {}

        def inner(*a, **kw):
            if _weave is None:
                return f(*a, **kw)
            if "w" not in cache:
                cache["w"] = _weave.op(name=name or f.__name__)(f)
            return cache["w"](*a, **kw)
        inner.__name__ = f.__name__
        inner.__doc__ = f.__doc__
        return inner
    return wrap(fn) if fn else wrap


def _extract_json(text):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    m = re.search(r"\{.*\}", text, flags=re.S)
    return json.loads(m.group(0) if m else text)


@op(name="llm.chat_json")
def chat_json(system, user, max_tokens=None, temperature=0.2, thinking=None):
    """Recorded for replay: a dropped W&B connection answers from the last successful identical call."""
    from backend import replay
    return replay.call("wandb_llm", [C.LLM_MODEL, system, user], lambda: _chat_json(system, user, max_tokens,
                                                                                    temperature, thinking))


def _chat_json(system, user, max_tokens=None, temperature=0.2, thinking=None):
    """One JSON-mode completion. Raises on transport or parse errors (callers fall back).
    If reasoning eats the whole budget, retries once with reasoning off."""
    thinking = C.LLM_THINKING if thinking is None else thinking
    r = _client.chat.completions.create(
        model=C.LLM_MODEL, temperature=temperature,
        max_tokens=max_tokens or (C.LLM_MAX_TOKENS if thinking else 1200),
        response_format={"type": "json_object"},
        extra_body={"chat_template_kwargs": {"enable_thinking": thinking}},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
    choice = r.choices[0]
    if not choice.message.content:
        if thinking:
            return _chat_json(system, user, None, temperature, thinking=False)
        raise ValueError(f"empty content (finish_reason={choice.finish_reason})")
    return _extract_json(choice.message.content)


def pmap(fn, items, workers=6):
    """Parallel map that keeps the Weave trace parent for each call."""
    import contextvars
    from concurrent.futures import ThreadPoolExecutor
    items = list(items)
    if len(items) <= 1:
        return [fn(x) for x in items]
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(lambda x: contextvars.copy_context().run(fn, x), items))
