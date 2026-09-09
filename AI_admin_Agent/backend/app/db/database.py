from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, Text
from sqlalchemy.orm import sessionmaker, declarative_base
import datetime
import os
import json

from app.core.admin_data_dir import admin_sqlite_path, migrate_legacy_admin_data

migrate_legacy_admin_data()
DB_PATH = str(admin_sqlite_path())
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

LEGACY_USER_ID = "__legacy__"
DEFAULT_TENANT_ID = "default"


class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    description = Column(String, nullable=True)
    completed = Column(Boolean, default=False)
    due_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)


class Event(Base):
    __tablename__ = "events"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    start_time = Column(DateTime)
    end_time = Column(DateTime, nullable=True)
    description = Column(String, nullable=True)
    completed = Column(Boolean, default=False)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)


class Memory(Base):
    __tablename__ = "memories"
    id = Column(Integer, primary_key=True, index=True)
    content = Column(String)
    preference_type = Column(String)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)


class Contact(Base):
    __tablename__ = "contacts"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    email = Column(String, index=True)
    description = Column(String, nullable=True)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)


class PendingAction(Base):
    __tablename__ = "pending_actions"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True)
    tool_name = Column(String, index=True)
    tool_args_json = Column(Text)  # JSON string
    status = Column(String, default="pending")  # pending/confirmed/cancelled/executed/failed
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    decided_at = Column(DateTime, nullable=True)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)

    def get_args(self) -> dict:
        try:
            return json.loads(self.tool_args_json or "{}")
        except Exception:
            return {}


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True)
    tool_name = Column(String, index=True)
    tool_args_json = Column(Text)
    result_text = Column(Text)
    status = Column(String, default="ok")  # ok/blocked/pending/error
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)


class Note(Base):
    __tablename__ = "notes"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)
    user_id = Column(String, index=True, default=LEGACY_USER_ID)


class MailboxBinding(Base):
    """Per-user domestic mailbox binding (auth code stored encrypted)."""

    __tablename__ = "mailbox_bindings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True, nullable=False)
    provider = Column(String, nullable=False, default="qq")
    email_address = Column(String, nullable=False)
    auth_code_cipher = Column(Text, nullable=False)
    imap_server = Column(String, nullable=False)
    imap_port = Column(Integer, default=993)
    smtp_server = Column(String, nullable=False)
    smtp_port = Column(Integer, default=465)
    verified_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    tenant_id = Column(String, index=True, default=DEFAULT_TENANT_ID)


def _ensure_owner_columns(conn, table: str) -> None:
    try:
        cols = [row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table});").fetchall()]
    except Exception:
        return
    if "tenant_id" not in cols:
        try:
            conn.exec_driver_sql(
                f"ALTER TABLE {table} ADD COLUMN tenant_id VARCHAR DEFAULT '{DEFAULT_TENANT_ID}';"
            )
        except Exception:
            pass
    if "user_id" not in cols:
        try:
            conn.exec_driver_sql(
                f"ALTER TABLE {table} ADD COLUMN user_id VARCHAR DEFAULT '{LEGACY_USER_ID}';"
            )
        except Exception:
            pass
    # 存量：空值打标为 legacy，新用户默认看不到
    try:
        conn.exec_driver_sql(
            f"UPDATE {table} SET tenant_id = '{DEFAULT_TENANT_ID}' "
            f"WHERE tenant_id IS NULL OR trim(tenant_id) = '';"
        )
        conn.exec_driver_sql(
            f"UPDATE {table} SET user_id = '{LEGACY_USER_ID}' "
            f"WHERE user_id IS NULL OR trim(user_id) = '';"
        )
    except Exception:
        pass


def _ensure_sqlite_schema() -> None:
    """
    Very small, pragmatic schema migration for sqlite.
    create_all() won't add new columns to existing tables.
    """
    with engine.connect() as conn:
        # tasks.due_at
        try:
            cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(tasks);").fetchall()]
            if "due_at" not in cols:
                conn.exec_driver_sql("ALTER TABLE tasks ADD COLUMN due_at DATETIME;")
        except Exception:
            pass

        # events.completed
        try:
            cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(events);").fetchall()]
            if "completed" not in cols:
                conn.exec_driver_sql("ALTER TABLE events ADD COLUMN completed BOOLEAN DEFAULT 0;")
        except Exception:
            pass

        for table in (
            "tasks",
            "events",
            "memories",
            "contacts",
            "notes",
            "pending_actions",
            "audit_logs",
            "mailbox_bindings",
        ):
            _ensure_owner_columns(conn, table)

        try:
            conn.commit()
        except Exception:
            pass


# Create tables + ensure new columns exist
Base.metadata.create_all(bind=engine)
_ensure_sqlite_schema()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
