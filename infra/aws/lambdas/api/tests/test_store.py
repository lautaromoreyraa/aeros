from __future__ import annotations

import duckdb

from aeros_api import store


def test_lambda_connection_settings_are_accepted(monkeypatch, tmp_path):
    # Opening a connection is the only way to know DuckDB takes every option;
    # a typo here would only surface on the first cold start in AWS.
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "512")
    config = store._lambda_config()
    config["home_directory"] = str(tmp_path)
    config["temp_directory"] = str(tmp_path / "duckdb")
    con = duckdb.connect(config=config)
    assert con.execute("SELECT current_setting('TimeZone')").fetchone() == ("UTC",)
    assert config["memory_limit"] == "307MB"


def test_quote_escapes_single_quotes():
    assert store._quote("a'b") == "'a''b'"
