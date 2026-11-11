"""Agent adapters. The platform manages agents; it is not one.

Adapter contract: do(item) -> Result, verify(item, result) -> (ok, evidence).
Built in:
  SimulatedAgent  deterministic, seedable; used for demos, tests and CI (never claims to be a real model)
  CommandAgent    runs any CLI agent (claude -p, codex exec, ...) in a work dir; verification by a check command
  AnthropicAgent  calls the Anthropic Messages API (set ANTHROPIC_API_KEY); text-only proposals
  VertexAgent     calls a Gemini model on Vertex AI (VERTEX_ACCESS_TOKEN, VERTEX_PROJECT, VERTEX_LOCATION in env); text-only proposals
"""
from __future__ import annotations
import hashlib, json, os, shlex, subprocess, urllib.error, urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional
from .config import DEFAULT_WORKERS_AI_MODEL, DEFAULT_VERTEX_MODEL, workers_ai_vendor


@dataclass
class Result:
    ok: bool
    evidence: str
    hidden_failure: bool = False          # doer believes it worked, but it did not (reviewer should catch)
    revert: Optional[Callable[[], None]] = None


def _h(*parts) -> float:
    d = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return int.from_bytes(d[:8], "big") / 2**64


class SimulatedAgent:
    kind = "simulated"

    def __init__(self, name: str, seed: int = 7, fail_rate: float = 0.12, hidden_rate: float = 0.04,
                 catch_rate: float = 0.9):
        self.name, self.seed = name, seed
        self.fail_rate, self.hidden_rate, self.catch_rate = fail_rate, hidden_rate, catch_rate

    def do(self, item: dict) -> Result:
        r = _h(self.seed, self.name, item["id"], item.get("attempts", 0))
        if r < self.fail_rate:
            return Result(False, f"simulated failure: checks red for {item['id']}")
        if r < self.fail_rate + self.hidden_rate:
            return Result(True, f"simulated change for {item['id']} (looks green)", hidden_failure=True)
        return Result(True, f"simulated change for {item['id']}; done_check satisfied")

    def verify(self, item: dict, res: Result):
        if res.hidden_failure:
            if _h(self.seed, self.name, "catch", item["id"], item.get("attempts", 0)) < self.catch_rate:
                return False, "reviewer reproduced independently: the claimed result does not hold"
            return True, "reviewer pass (missed hidden failure)"
        return res.ok, "reviewer reproduced independently: " + ("pass" if res.ok else "fail")


class CommandAgent:
    """Run a CLI agent. `command` receives the item brief on stdin; `check` is the independent verifier."""
    kind = "command"

    def __init__(self, name: str, command: str, check: Optional[str] = None, cwd: str = ".", timeout: int = 1800):
        self.name, self.command, self.check, self.cwd, self.timeout = name, command, check, cwd, timeout

    def do(self, item: dict) -> Result:
        brief = f"{item['title']}\n\nDone when: {item['done_check']}\nProbe: {item.get('closing_probe') or ''}\n"
        try:
            p = subprocess.run(shlex.split(self.command), input=brief, capture_output=True, text=True,
                               cwd=self.cwd, timeout=self.timeout)
        except Exception as e:  # noqa: BLE001 - recorded as evidence, never swallowed
            return Result(False, f"command error: {e}")
        return Result(p.returncode == 0, (p.stdout or p.stderr)[-2000:])

    def verify(self, item: dict, res: Result):
        if not res.ok:
            return False, res.evidence
        if not self.check:
            return False, "no independent check configured; refusing to self-certify"
        p = subprocess.run(shlex.split(self.check), capture_output=True, text=True, cwd=self.cwd, timeout=self.timeout)
        return p.returncode == 0, (p.stdout or p.stderr)[-2000:]


class AnthropicAgent:
    kind = "anthropic"

    def __init__(self, name: str, model: str, api_key_env: str = "ANTHROPIC_API_KEY"):
        self.name, self.model, self.key_env = name, model, api_key_env

    def _call(self, prompt: str) -> str:
        key = os.environ.get(self.key_env)
        if not key:
            raise RuntimeError(f"{self.key_env} not set")
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps({"model": self.model, "max_tokens": 1024,
                             "messages": [{"role": "user", "content": prompt}]}).encode(),
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())["content"][0]["text"]

    def do(self, item: dict) -> Result:
        try:
            return Result(True, self._call(f"Produce a concise plan and change summary for: {item['title']}\nDone when: {item['done_check']}"))
        except Exception as e:  # noqa: BLE001
            return Result(False, f"anthropic error: {e}")

    def verify(self, item: dict, res: Result):
        try:
            out = self._call(f"Task: {item['title']}\nDone when: {item['done_check']}\nClaimed result:\n{res.evidence}\n"
                             "Reply PASS or FAIL then one line why.")
            return out.strip().upper().startswith("PASS"), out[:500]
        except Exception as e:  # noqa: BLE001
            return False, f"verifier error: {e}"


class VertexAgent:
    """Gemini on Vertex AI over REST. Project, location and token come from env or the spec, never from constants.
    `transport(prompt) -> str` is injectable so tests run without a network."""
    kind = "vertex"

    def __init__(self, name: str, model: str = DEFAULT_VERTEX_MODEL, project: Optional[str] = None,
                 location: Optional[str] = None, transport: Optional[Callable[[str], str]] = None,
                 token_source: Optional[Callable[[], str]] = None):
        self.token_source = token_source
        self.name, self.model = name, model
        self.project, self.location = project, location
        self.transport = transport or self._http

    def _token(self) -> Optional[str]:
        """Current access token: `token_source()` when given (called again after a 401), else the environment."""
        return self.token_source() if self.token_source else os.environ.get("VERTEX_ACCESS_TOKEN")

    def _http(self, prompt: str) -> str:
        try:
            return self._post(prompt)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            return self._post(prompt)  # access tokens expire about hourly: one retry with a freshly read token

    def _post(self, prompt: str) -> str:
        tok = self._token()
        project = self.project or os.environ.get("VERTEX_PROJECT")
        location = self.location or os.environ.get("VERTEX_LOCATION")
        if not (tok and project and location):
            raise RuntimeError("VERTEX_ACCESS_TOKEN, VERTEX_PROJECT and VERTEX_LOCATION required")
        url = (f"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}"
               f"/publishers/google/models/{self.model}:generateContent")
        req = urllib.request.Request(
            url, data=json.dumps({"contents": [{"role": "user", "parts": [{"text": prompt}]}]}).encode(),
            headers={"authorization": f"Bearer {tok}", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())["candidates"][0]["content"]["parts"][0]["text"]

    def do(self, item: dict) -> Result:
        try:
            return Result(True, self.transport(f"Produce a concise plan and change summary for: {item['title']}\nDone when: {item['done_check']}"))
        except Exception as e:  # noqa: BLE001 - recorded as evidence
            return Result(False, f"vertex error: {e}")

    def verify(self, item: dict, res: Result):
        try:
            out = self.transport(f"Task: {item['title']}\nDone when: {item['done_check']}\nClaimed result:\n{res.evidence}\n"
                                 "Reply PASS or FAIL then one line why.")
            return out.strip().upper().startswith("PASS"), out[:500]
        except Exception as e:  # noqa: BLE001
            return False, f"verifier error: {e}"


class WorkersAIAgent:
    """Edits files in `cwd` using a Cloudflare Workers AI model (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env).
    The model returns full replacement files; originals are kept so a failed review can revert. Verified by a separate check command."""
    kind = "workers-ai"

    def __init__(self, name, files, cwd=".", check=None, model=DEFAULT_WORKERS_AI_MODEL, transport=None):
        self.name, self.files, self.cwd, self.check, self.model = name, files, cwd, check, model
        self.transport = transport or self._http

    def _http(self, prompt: str) -> str:
        tok, acct = os.environ.get("CLOUDFLARE_API_TOKEN"), os.environ.get("CLOUDFLARE_ACCOUNT_ID")
        if not (tok and acct):
            raise RuntimeError("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required")
        req = urllib.request.Request(
            f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{self.model}",
            data=json.dumps({"messages": [{"role": "user", "content": prompt}], "max_tokens": 2000}).encode(),
            headers={"authorization": f"Bearer {tok}", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.loads(r.read())["result"]["response"]
        return resp if isinstance(resp, str) else json.dumps(resp)  # Workers AI may return pre-parsed JSON

    def do(self, item: dict) -> Result:
        orig = {f: open(os.path.join(self.cwd, f), encoding="utf-8").read() for f in self.files}
        NL = chr(10)
        files = NL.join("--- " + f + " ---" + NL + c for f, c in orig.items())
        prompt = ("Task: " + item["title"] + NL + "Done when: " + item["done_check"] + NL + NL + "Files:" + NL + files +
                  NL + NL + "Reply with ONLY a JSON object mapping each file you change to its COMPLETE new content.")
        try:
            out = self.transport(prompt)
            a, b = out.index("{"), out.rindex("}") + 1
            changes = json.loads(out[a:b])
            for f, c in changes.items():
                if f not in orig:
                    raise ValueError(f"model tried to write unlisted file {f}")
        except Exception as e:  # noqa: BLE001
            return Result(False, f"model error: {e}")
        for f, c in changes.items():
            open(os.path.join(self.cwd, f), "w", encoding="utf-8").write(c)

        def revert():
            for f, c in orig.items():
                open(os.path.join(self.cwd, f), "w", encoding="utf-8").write(c)
        return Result(True, f"{self.model} rewrote {', '.join(changes)}", revert=revert)

    def verify(self, item, res):
        if not res.ok:
            return False, res.evidence
        if not self.check:
            return False, "no independent check configured; refusing to self-certify"
        p = subprocess.run(shlex.split(self.check), capture_output=True, text=True, cwd=self.cwd, timeout=600)
        return p.returncode == 0, (p.stdout + p.stderr)[-1500:]


def build_agent(spec: dict, name: str):
    k = spec.get("kind", "simulated")
    if k == "simulated":
        return SimulatedAgent(name, **{a: spec[a] for a in ("seed", "fail_rate", "hidden_rate", "catch_rate") if a in spec})
    if k == "command":
        return CommandAgent(name, spec["command"], spec.get("check"), spec.get("cwd", "."))
    if k == "anthropic":
        return AnthropicAgent(name, spec["model"])
    if k == "vertex":
        return VertexAgent(name, spec.get("model", DEFAULT_VERTEX_MODEL), spec.get("project"), spec.get("location"))
    if k == "workers-ai":
        return WorkersAIAgent(name, spec["files"], spec.get("cwd", "."), spec.get("check"), spec.get("model", DEFAULT_WORKERS_AI_MODEL))
    raise ValueError(f"unknown agent kind {k}")


def model_family(spec: dict) -> Optional[str]:
    """Model family of an agent spec, or None for agents that are not a model (simulated, command)."""
    k = spec.get("kind", "simulated")
    if k == "anthropic":
        return "anthropic"
    if k == "vertex":
        return "google"
    if k == "workers-ai":
        return workers_ai_vendor(spec.get("model", DEFAULT_WORKERS_AI_MODEL))
    return None


def check_pairing(doer: dict, reviewer: dict) -> None:
    """A reviewer from the same model family as its doer shares its blind spots; refuse that pairing."""
    a, b = model_family(doer), model_family(reviewer)
    if a and b and a == b:
        raise ValueError(f"reviewer model family '{b}' is the same as the doer's; pair different families")
