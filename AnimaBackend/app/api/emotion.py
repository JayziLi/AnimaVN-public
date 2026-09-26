"""情绪识别:AI 写的立绘标签对不上立绘名时,挑列表里最像的一个。

接口不查库、不存状态:候选(立绘名 + 别名,或内置基础表情)由前端带过来。
两个接口都是同步函数,FastAPI 会放进线程池跑,推理不堵事件循环。
设计见 docs/superpowers/specs/2026-09-25-sprite-emotion-matching-design.md
"""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from app.emotion.encoder import MODEL_NAME
from app.emotion.matcher import Candidate, EmotionMatcher
from app.emotion.service import EmotionUnavailable, get_matcher

router = APIRouter(prefix="/api/emotion", tags=["emotion"])

Word = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class CandidateIn(BaseModel):
    key: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    names: list[Word] = Field(min_length=1, max_length=20)


class MatchIn(BaseModel):
    tags: list[Word] = Field(min_length=1, max_length=50)
    candidates: list[CandidateIn] = Field(min_length=1, max_length=200)


class MatchOut(BaseModel):
    tag: str
    key: str
    name: str
    score: float


class MatchResponse(BaseModel):
    model: str
    results: list[MatchOut]


class StatusOut(BaseModel):
    ready: bool
    model: str
    detail: str | None


def use_matcher() -> EmotionMatcher:
    try:
        return get_matcher()
    except EmotionUnavailable as e:
        raise HTTPException(503, str(e)) from e


@router.post("/match", response_model=MatchResponse)
def match(req: MatchIn, matcher: EmotionMatcher = Depends(use_matcher)):
    candidates = [Candidate(c.key, tuple(c.names)) for c in req.candidates]
    results = matcher.match(req.tags, candidates)
    return MatchResponse(model=matcher.model, results=[MatchOut(**asdict(r)) for r in results])


@router.get("/status", response_model=StatusOut)
def status():
    """顺带触发加载:装了但加载失败也能从这里看出来"""
    try:
        m = get_matcher()
    except EmotionUnavailable as e:
        return StatusOut(ready=False, model=MODEL_NAME, detail=str(e))
    return StatusOut(ready=True, model=m.model, detail=None)
