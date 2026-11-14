"""ChatGPT (GPT 6 Sol) session coach + chat assistant — advice only.

The AI never places, starts or stops trades; it only reads the session
context the browser sends (stats, settings, recent trades — never tokens).
Responses stream as Server-Sent Events:  data: {"delta": "..."}  …  data: {"done": true}
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import AsyncIterator, List

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from emergentintegrations.llm.chat import LlmChat, StreamDone, TextDelta, UserMessage

from lib.db import db
from models.ai import ChatHistory, ChatMessage, ChatRequest, CoachRequest, SessionContext

router = APIRouter()
log = logging.getLogger(__name__)

MODEL_PROVIDER = "openai"
MODEL_NAME = "gpt-6-sol"
HISTORY_TURNS = 20  # messages of chat history replayed to the model

BASE_RULES = """You are the built-in AI coach of "Deriv Edge Lab", a Deriv Digit Differs bot.
Facts you must respect:
- The bot trades ONLY Digit Differs, 1-tick contracts on Volatility indices. A trade wins when the last digit of the
  next tick is NOT the chosen digit (about 90% of ticks). Every digit is equally likely on every tick; past ticks do not
  predict the next one.
- Deriv's Differs payout is about 1.07-1.10x the stake, so a win earns roughly 7-10% of the stake and a loss costs 100%.
  Break-even win rate = 1 / payout multiplier (about 92-93%). Over many trades the expected result is a small loss
  per trade (house edge). Say this plainly when relevant.
- No setting, digit choice, 'smart entry' or pattern makes the bot win more. Never promise or imply profit.
  You may suggest risk controls: smaller stake relative to balance, stop loss, take profit, daily loss cap,
  daily target, practising on Demo, pausing after loss streaks.
- You give advice only. You cannot start, stop or place trades and must not pretend to.
- Real-money trading is risky; remind the user when the mode is live on a real account. Not financial advice.
Style: plain text, short paragraphs or '-' bullets, no markdown headings or bold, under 180 words unless asked for more.
Use the user's currency for amounts."""


def _api_key() -> str:
    return os.environ.get("EMERGENT_LLM_KEY", "")


def _context_block(ctx: SessionContext) -> str:
    data = ctx.model_dump()
    trades = data.pop("recent_trades", [])
    lines = [f"Current session context (JSON): {json.dumps(data, default=str)}"]
    if trades:
        compact = [
            f"{'L' if t['live'] else 'S'} {t['symbol']} d{t['digit']}->{t['result_digit'] if t['result_digit'] is not None else '?'} "
            f"stake {t['stake']:.2f} pnl {t['pnl']:+.2f}"
            for t in trades[:60]
        ]
        lines.append("Most recent trades, newest first (L=live, S=simulated):\n" + "\n".join(compact))
    return "\n".join(lines)


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def _stream(chat: LlmChat, text: str, on_done=None) -> AsyncIterator[str]:
    parts: List[str] = []
    try:
        async for ev in chat.stream_message(UserMessage(text=text)):
            if isinstance(ev, TextDelta):
                parts.append(ev.content)
                yield _sse({"delta": ev.content})
            elif isinstance(ev, StreamDone):
                break
        full = "".join(parts).strip()
        if on_done and full:
            await on_done(full)
        yield _sse({"done": True})
    except Exception as exc:  # surface a friendly error to the UI
        log.warning("ai stream failed: %s", type(exc).__name__)
        yield _sse({"error": "The AI is unavailable right now — please try again in a moment."})


def _sse_response(gen: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        gen,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ai/coach")
async def ai_coach(body: CoachRequest) -> StreamingResponse:
    """One-shot analysis of the current session."""
    chat = LlmChat(
        api_key=_api_key(),
        session_id=f"coach-{datetime.now(timezone.utc).timestamp()}",
        system_message=BASE_RULES,
    ).with_model(MODEL_PROVIDER, MODEL_NAME)
    prompt = (
        _context_block(body.context)
        + "\n\nAnalyse this session for the user: how it went (wins, losses, net P/L, what drove it — e.g. one loss "
        "wiping out many small wins), whether the stake and limits fit the balance, and 2-4 concrete risk-setting "
        "changes. If there are no trades yet, explain what to set before starting."
    )
    return _sse_response(_stream(chat, prompt))


@router.post("/ai/chat")
async def ai_chat(body: ChatRequest) -> StreamingResponse:
    """Multi-turn chat; history is stored in Mongo per browser session_id."""
    docs = (
        await db.ai_messages.find({"session_id": body.session_id}, {"_id": 0})
        .sort("created_at", -1)
        .to_list(HISTORY_TURNS)
    )
    docs.reverse()
    system = BASE_RULES + ("\n\n" + _context_block(body.context) if body.context else "")
    initial = [{"role": "system", "content": system}] + [
        {"role": d["role"], "content": d["text"]} for d in docs
    ]
    chat = LlmChat(
        api_key=_api_key(),
        session_id=body.session_id,
        system_message=system,
        initial_messages=initial,
    ).with_model(MODEL_PROVIDER, MODEL_NAME)

    async def save(reply: str) -> None:
        now = datetime.now(timezone.utc)
        await db.ai_messages.insert_many(
            [
                {"session_id": body.session_id, "role": "user", "text": body.message, "created_at": now},
                {"session_id": body.session_id, "role": "assistant", "text": reply, "created_at": now.replace(microsecond=min(now.microsecond + 1, 999999))},
            ]
        )

    return _sse_response(_stream(chat, body.message, on_done=save))


@router.get("/ai/chat/{session_id}", response_model=ChatHistory)
async def ai_chat_history(session_id: str) -> ChatHistory:
    docs = await db.ai_messages.find({"session_id": session_id}, {"_id": 0}).sort("created_at", 1).to_list(200)
    msgs = [
        ChatMessage(role=d["role"], text=d["text"], created_at=d["created_at"].replace(tzinfo=timezone.utc))
        for d in docs
    ]
    return ChatHistory(session_id=session_id, messages=msgs)


@router.delete("/ai/chat/{session_id}")
async def ai_chat_clear(session_id: str) -> dict:
    res = await db.ai_messages.delete_many({"session_id": session_id})
    return {"deleted": res.deleted_count}
