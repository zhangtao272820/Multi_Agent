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

class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    description = Column(String, nullable=True)
    completed = Column(Boolean, default=False)
    due_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Event(Base):
    __tablename__ = "events"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    start_time = Column(DateTime)
    end_time = Column(DateTime, nullable=True)
    description = Column(String, nullable=True)
    completed = Column(Boolean, default=False)

class Memory(Base):
    __tablename__ = "memories"
    id = Column(Integer, primary_key=True, index=True)
    content = Column(String)
    preference_type = Column(String)

class Contact(Base):
    __tablename__ = "contacts"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    email = Column(String, index=True)
    description = Column(String, nullable=True)

class PendingAction(Base):
    __tablename__ = "pending_actions"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True)
    tool_name = Column(String, index=True)
    tool_args_json = Column(Text)  # JSON string
    status = Column(String, default="pending")  # pending/confirmed/cancelled/executed/failed
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    decided_at = Column(DateTime, nullable=True)

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

class Note(Base):
    __tablename__ = "notes"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


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


# Create tables + ensure new columns exist
Base.metadata.create_all(bind=engine)
_ensure_sqlite_schema()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
