"""全局设置的键值存取。

目前只有插件配置在用(键名是 plugin.<插件名>)。值是任意 JSON,
结构由前端的插件自己定义,后端不校验 —— 以后加插件不用改后端。
"""

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AppSetting
from app.schemas import AppSettingIn, AppSettingOut

router = APIRouter(prefix="/api/settings", tags=["settings"])

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")


def _check_key(key: str) -> None:
    if not _KEY_RE.match(key):
        raise HTTPException(400, "设置名只能用小写字母、数字和 _ . -")


@router.get("/{key}", response_model=AppSettingOut)
def get_setting(key: str, db: Session = Depends(get_db)):
    _check_key(key)
    row = db.get(AppSetting, key)
    # 还没存过就回 null,前端用自己的默认值。不回 404:页面每次打开都要读一遍,
    # 404 会在浏览器控制台里留一条红色报错,看着像出了故障
    return AppSettingOut(key=key, value=row.value if row else None)


@router.put("/{key}", response_model=AppSettingOut)
def put_setting(key: str, req: AppSettingIn, db: Session = Depends(get_db)):
    _check_key(key)
    row = db.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=req.value)
        db.add(row)
    else:
        row.value = req.value
    db.commit()
    return AppSettingOut(key=key, value=row.value)
