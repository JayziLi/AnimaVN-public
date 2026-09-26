from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Persona
from app.schemas import PersonaCreate, PersonaOut, PersonaUpdate

router = APIRouter(prefix="/api/personas", tags=["personas"])


def _load(persona_id: str, db: Session) -> Persona:
    persona = db.get(Persona, persona_id)
    if persona is None:
        raise HTTPException(404, "Persona not found")
    return persona


def active_persona(db: Session) -> Persona | None:
    """发消息时取激活人设;给 chat.py 用。"""
    return db.scalar(select(Persona).where(Persona.is_active))


@router.get("", response_model=list[PersonaOut])
def list_personas(db: Session = Depends(get_db)):
    return db.scalars(select(Persona).order_by(Persona.created_at)).all()


@router.post("", response_model=PersonaOut)
def create_persona(req: PersonaCreate, db: Session = Depends(get_db)):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "人设名称不能为空")
    persona = Persona(
        name=name,
        description=req.description,
        avatar=req.avatar,
        # 第一个人设自动激活,和连接的 seeding 行为一致
        is_active=db.scalar(select(Persona)) is None,
    )
    db.add(persona)
    db.commit()
    db.refresh(persona)
    return persona


@router.patch("/{persona_id}", response_model=PersonaOut)
def update_persona(persona_id: str, req: PersonaUpdate, db: Session = Depends(get_db)):
    persona = _load(persona_id, db)
    updates = req.model_dump(exclude_unset=True)
    if "name" in updates:
        name = updates["name"].strip()
        if not name:
            raise HTTPException(400, "人设名称不能为空")
        updates["name"] = name
    for field, value in updates.items():
        setattr(persona, field, value)
    db.commit()
    db.refresh(persona)
    return persona


@router.delete("/{persona_id}", status_code=204)
def delete_persona(persona_id: str, db: Session = Depends(get_db)):
    persona = _load(persona_id, db)
    # 删掉的是激活人设就让它空着,不自动转移
    db.delete(persona)
    db.commit()


@router.put("/{persona_id}/activate", response_model=PersonaOut)
def activate_persona(persona_id: str, db: Session = Depends(get_db)):
    persona = _load(persona_id, db)
    # 先把所有人设熄灭再点亮这一个,维持"最多一个激活"的不变量
    for other in db.scalars(select(Persona).where(Persona.is_active)):
        other.is_active = False
    persona.is_active = True
    db.commit()
    db.refresh(persona)
    return persona
