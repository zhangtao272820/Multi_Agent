import uvicorn

from app.settings import get_settings


def main() -> None:
    s = get_settings()
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(s.vanna_port), reload=False)


if __name__ == "__main__":
    main()
