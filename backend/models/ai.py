"""Request/response models for the AI coach + chat assistant."""

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class TradeSnapshot(BaseModel):
    live: bool = False
    symbol: str = Field(default="", max_length=20)
    product: str = Field(default="differs", max_length=20)
    detail: str = Field(default="", max_length=120)
    digit: Optional[int] = Field(default=None, ge=0, le=9)
    result_digit: Optional[int] = Field(default=None, ge=0, le=9)
    stake: float = Field(ge=0)
    pnl: float
    win: bool


class SessionContext(BaseModel):
    """What the browser knows about the current session — no tokens, no account ids."""

    mode: Literal["sim", "live"] = "sim"
    account_type: Optional[Literal["demo", "real"]] = None
    currency: str = Field(default="USD", max_length=10)
    balance: Optional[float] = None
    symbol: str = Field(default="R_100", max_length=20)
    digit: int = Field(default=5, ge=0, le=9)
    stake: float = Field(default=1, ge=0)
    product: str = Field(default="differs", max_length=20)
    growth_rate: Optional[float] = None
    multiplier: Optional[float] = None
    direction: Optional[str] = Field(default=None, max_length=10)
    contract_take_profit: Optional[float] = None
    max_trades: Optional[int] = None
    max_drawdown: Optional[float] = None
    payout_multiplier: Optional[float] = None
    take_profit: Optional[float] = None
    stop_loss: Optional[float] = None
    daily_loss_cap: Optional[float] = None
    daily_target: Optional[float] = None
    today_live_net: float = 0
    trades: int = 0
    wins: int = 0
    losses: int = 0
    net: float = 0
    streak: int = 0
    recent_trades: List[TradeSnapshot] = Field(default_factory=list, max_length=60)


class CoachRequest(BaseModel):
    context: SessionContext


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    message: str = Field(min_length=1, max_length=2000)
    context: Optional[SessionContext] = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    created_at: datetime


class ChatHistory(BaseModel):
    session_id: str
    messages: List[ChatMessage]
