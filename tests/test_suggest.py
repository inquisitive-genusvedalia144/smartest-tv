"""Tests for context-aware home-dashboard suggestions (ui/suggest.py)."""
from __future__ import annotations

from smartest_tv.ui.suggest import suggest_for


def test_empty_history_returns_fallback_suggestions():
    result = suggest_for(history=[])
    assert len(result) == 3
    # Should include either whats-on or scene/insights
    commands = [s["command"] for s in result]
    assert any("scene" in c or "whats-on" in c or "insights" in c for c in commands)


def test_none_history_behaves_like_empty():
    result = suggest_for(history=None)
    assert len(result) == 3


def test_netflix_show_with_episode_suggests_next():
    history = [{
        "platform": "netflix",
        "query": "Wednesday",
        "season": 1,
        "episode": 1,
    }]
    result = suggest_for(history=history)
    assert any(s["command"] == "stv next" for s in result)
    next_entry = next(s for s in result if s["command"] == "stv next")
    assert "Wednesday" in next_entry["description"]
    assert "S1E2" in next_entry["description"]


def test_recent_youtube_suggests_trending():
    history = [{"platform": "youtube", "query": "baby shark"}]
    result = suggest_for(history=history)
    assert any("whats-on youtube" in s["command"] for s in result)


def test_idle_tv_prioritizes_whats_on():
    """When the TV is on the home screen, suggest discovery first."""
    result = suggest_for(history=[], app_id="com.webos.app.home")
    assert result[0]["command"] == "stv whats-on"


def test_max_three_suggestions():
    history = [
        {"platform": "netflix", "query": "Wednesday", "season": 1, "episode": 1},
        {"platform": "youtube", "query": "baby shark"},
    ]
    result = suggest_for(history=history)
    assert len(result) <= 3


def test_suggestions_have_required_keys():
    result = suggest_for(history=[])
    for s in result:
        assert "icon" in s
        assert "command" in s
        assert "description" in s
        assert s["command"].startswith("stv ")
