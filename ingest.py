#!/usr/bin/env python3
"""Build a provenance-first startup/founder signal dataset from public APIs.

This script intentionally produces *people candidates*, not asserted founders:
GitHub owners, HN authors, and arXiv authors have not necessarily founded a company.
YC founder names are retained as YC-provided company data.  Cross-source identity
matching is deliberately conservative: only exact normalized names/handles merge.

Install:  python -m pip install requests pandas
Run:      python ingest.py
Optional: GITHUB_TOKEN=... python ingest.py
"""

from __future__ import annotations

import argparse
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import requests


GITHUB_URL = "https://api.github.com/search/repositories"
HN_URL = "https://hn.algolia.com/api/v1/search_by_date"
ARXIV_URL = "https://export.arxiv.org/api/query"
YC_URL = "https://yc-oss.github.io/api/companies/all.json"
SIGNAL_COLUMNS = [
    "signal_id", "source", "person_or_handle", "company", "text", "url",
    "date", "reliability",
]


class HttpClient:
    def __init__(self, token: str | None, delay: float) -> None:
        headers = {"Accept": "application/json", "User-Agent": "vc-signal-demo/1.0"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self.session = requests.Session()
        self.session.headers.update(headers)
        self.delay = delay

    def get(self, url: str, *, params: dict[str, Any] | None = None, accept: str | None = None) -> requests.Response:
        for attempt in range(4):
            try:
                headers = {"Accept": accept} if accept else None
                response = self.session.get(url, params=params, headers=headers, timeout=30)
                if response.status_code == 429 or response.status_code >= 500:
                    wait = float(response.headers.get("Retry-After", min(30, 2 ** attempt)))
                    print(f"  {response.status_code} from {url}; retrying in {wait:.0f}s")
                    time.sleep(wait)
                    continue
                if response.status_code == 403 and response.headers.get("X-RateLimit-Remaining") == "0":
                    reset = int(response.headers.get("X-RateLimit-Reset", "0"))
                    wait = max(1, min(60, reset - int(time.time()) + 1))
                    print(f"  GitHub rate limit reached; retrying in {wait}s")
                    time.sleep(wait)
                    continue
                response.raise_for_status()
                time.sleep(self.delay)
                return response
            except requests.RequestException as exc:
                if attempt == 3:
                    raise RuntimeError(str(exc)) from exc
                time.sleep(2 ** attempt)
        raise RuntimeError("Request retries exhausted")


def iso_date(value: str | None) -> str:
    if not value:
        return ""
    return value[:10]


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def make_signal(source: str, person: str, company: str, text: str, url: str, date: str, reliability: float, key: str) -> dict[str, Any]:
    return {
        "signal_id": f"{source}:{key}", "source": source,
        "person_or_handle": clean_text(person), "company": clean_text(company),
        "text": clean_text(text), "url": url or "", "date": iso_date(date),
        "reliability": reliability,
    }


def fetch_github(client: HttpClient, since: str, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()
    for topic in ("llm", "ai-agents", "rag", "inference"):
        response = client.get(GITHUB_URL, params={
            "q": f"topic:{topic} created:>={since} stars:>10", "sort": "stars",
            "order": "desc", "per_page": min(limit, 100),
        })
        for repo in response.json().get("items", []):
            if repo["id"] in seen:
                continue
            seen.add(repo["id"])
            owner = repo.get("owner") or {}
            text = f"{repo.get('full_name', '')}: {repo.get('description') or 'No description'} | {repo.get('stargazers_count', 0)} stars, {repo.get('forks_count', 0)} forks."
            rows.append(make_signal(
                "github", owner.get("login", ""), repo.get("name", ""), text,
                repo.get("html_url", ""), repo.get("created_at", ""), 0.90, str(repo["id"]),
            ))
    return rows


def fetch_hn(client: HttpClient, since_epoch: int, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Separate searches maximize recall; title filtering prevents non-launch noise.
    for keyword in ("AI", "LLM", "agent", "RAG"):
        response = client.get(HN_URL, params={
            "query": f"Show HN {keyword}", "tags": "story",
            "numericFilters": f"created_at_i>{since_epoch}", "hitsPerPage": min(limit, 100),
        })
        for hit in response.json().get("hits", []):
            object_id = str(hit.get("objectID", ""))
            title = clean_text(hit.get("title"))
            if not object_id or object_id in seen or "show hn" not in title.lower():
                continue
            seen.add(object_id)
            url = hit.get("url") or f"https://news.ycombinator.com/item?id={object_id}"
            text = f"{title} | {hit.get('points') or 0} points."
            rows.append(make_signal("hacker_news", hit.get("author", ""), "", text, url,
                                    hit.get("created_at", ""), 0.80, object_id))
    return rows


def fetch_arxiv(client: HttpClient, since: datetime, limit: int) -> list[dict[str, Any]]:
    response = client.get(ARXIV_URL, params={
        "search_query": "cat:cs.AI OR cat:cs.LG", "start": 0,
        "max_results": limit, "sortBy": "submittedDate", "sortOrder": "descending",
    }, accept="application/atom+xml")
    root = ET.fromstring(response.content)
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    rows: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", ns):
        published = entry.findtext("atom:published", default="", namespaces=ns)
        try:
            if datetime.fromisoformat(published.replace("Z", "+00:00")) < since:
                continue
        except ValueError:
            continue
        author = entry.findtext("atom:author/atom:name", default="", namespaces=ns)
        title = clean_text(entry.findtext("atom:title", default="", namespaces=ns))
        arxiv_id = entry.findtext("atom:id", default="", namespaces=ns).rsplit("/", 1)[-1]
        rows.append(make_signal("arxiv", author, "", title,
                                f"https://arxiv.org/abs/{arxiv_id}", published, 0.95, arxiv_id))
    return rows


def recent_batches(companies: Iterable[dict[str, Any]], count: int = 4) -> set[str]:
    batches = {clean_text(c.get("batch")) for c in companies if clean_text(c.get("batch"))}
    def batch_key(batch: str) -> tuple[int, int]:
        match = re.fullmatch(r"([SW])([0-9]{2})", batch)
        return (int(match.group(2)), 1 if match.group(1) == "S" else 0) if match else (-1, -1)
    return set(sorted(batches, key=batch_key, reverse=True)[:count])


def fetch_yc(client: HttpClient) -> list[dict[str, Any]]:
    # yc-oss is a public community mirror; the raw source is retained in each URL.
    companies = client.get(YC_URL).json()
    batches = recent_batches(companies)
    rows: list[dict[str, Any]] = []
    for company in companies:
        if clean_text(company.get("batch")) not in batches:
            continue
        founders = company.get("founders") or []
        if isinstance(founders, str):
            founders = [founders]
        names = []
        for founder in founders:
            names.append(founder.get("name", "") if isinstance(founder, dict) else str(founder))
        # Some records omit founder names; keep the company evidence without inventing one.
        if not names:
            names = [""]
        name = clean_text(company.get("name"))
        text = f"YC {company.get('batch', '')}: {company.get('one_liner') or company.get('long_description') or ''}"
        url = f"https://www.ycombinator.com/companies/{company.get('slug', '')}"
        for index, founder in enumerate(names):
            rows.append(make_signal("yc", founder, name, text, url, "", 0.90,
                                    f"{company.get('id', name)}:{index}"))
    return rows


def identity_key(person: str) -> str:
    # Exact normalization only: do not guess that similar names are the same person.
    return re.sub(r"[^a-z0-9]", "", clean_text(person).casefold())


def build_people(signals: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    usable = signals[signals["person_or_handle"].str.strip().ne("")].copy()
    usable["identity_key"] = usable["person_or_handle"].map(identity_key)
    grouped = usable.groupby("identity_key", dropna=False)
    people = grouped.agg(
        person_or_handle=("person_or_handle", "first"),
        source_count=("source", "nunique"),
        sources=("source", lambda values: ";".join(sorted(set(values)))),
        companies=("company", lambda values: ";".join(sorted({v for v in values if v}))),
        signal_count=("signal_id", "count"),
    ).reset_index()
    duplicates_merged = len(usable) - len(people)
    return people.sort_values(["source_count", "signal_count"], ascending=False), duplicates_merged


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest public startup/founder signals.")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--limit", type=int, default=30, help="Maximum results per source query.")
    # Resolve the default against this file, not the caller's working directory.
    # This makes `python /path/to/ingest.py` safe to run from any terminal folder.
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parent / "data"))
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=args.days)
    client = HttpClient(os.getenv("GITHUB_TOKEN"), delay=0.7)
    collectors = {
        "github": lambda: fetch_github(client, since.date().isoformat(), args.limit),
        "hacker_news": lambda: fetch_hn(client, int(since.timestamp()), args.limit),
        "arxiv": lambda: fetch_arxiv(client, since, args.limit),
        "yc": lambda: fetch_yc(client),
    }
    all_rows: list[dict[str, Any]] = []
    source_counts: dict[str, int] = {}
    for name, collect in collectors.items():
        try:
            rows = collect()
            all_rows.extend(rows)
            source_counts[name] = len(rows)
        except Exception as exc:  # A single public API outage should not kill the demo.
            source_counts[name] = 0
            print(f"WARNING: {name} skipped: {exc}")

    signals = pd.DataFrame(all_rows, columns=SIGNAL_COLUMNS)
    people, duplicates = build_people(signals) if not signals.empty else (pd.DataFrame(), 0)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    signals.to_csv(output / "signals.csv", index=False)
    people.to_csv(output / "founders.csv", index=False)
    print("\nIngestion stats")
    for source, count in source_counts.items():
        print(f"  {source}: {count} rows")
    print(f"  duplicates merged: {duplicates}")
    print(f"  final people-candidate count: {len(people)}")
    print(f"\nWrote {output / 'signals.csv'} and {output / 'founders.csv'}")


if __name__ == "__main__":
    main()
