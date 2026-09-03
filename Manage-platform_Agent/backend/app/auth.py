import hashlib
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .db_models import UserRecord

settings = get_settings()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

# 与 governance.ALLOWED_ROLES 对齐；此处避免循环 import 用字面量
ALLOWED_ROLES = frozenset({"user", "viewer", "operator", "admin"})
CONTROL_PLANE_ROLES = frozenset({"viewer", "operator", "admin"})


def hash_password(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def verify_password(raw: str, hashed: str) -> bool:
    return hash_password(raw) == hashed


def create_access_token(username: str, role: str, tenant_id: str = "default") -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": username,
        "role": role,
        "tenant_id": str(tenant_id or "default").strip() or "default",
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def ensure_default_admin(db: Session) -> UserRecord | None:
    row = db.query(UserRecord).filter(UserRecord.username == settings.admin_username).first()
    if row:
        return row
    row = UserRecord(
        username=settings.admin_username,
        password_hash=hash_password(settings.admin_password),
        role="admin",
        tenant_id="default",
        auth_provider="local",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> UserRecord:
    username = decode_access_token(token).get("sub")
    user = db.query(UserRecord).filter(UserRecord.username == username).first()
    if not user and username == settings.admin_username:
        user = ensure_default_admin(db)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    return user


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        if not payload.get("sub"):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="token 缺少用户标识")
        return payload
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="token 无效") from exc


def require_roles(*roles: str):
    def dependency(user: UserRecord = Depends(get_current_user)) -> UserRecord:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不足")
        return user

    return dependency
