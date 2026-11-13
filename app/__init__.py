"""Attenda application package."""


def create_app(test_config=None):
    """Create the web app without importing it during ``python -m app.web``."""
    from .web import create_app as web_create_app

    return web_create_app(test_config)


__all__ = ["create_app"]
