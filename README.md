# Founder Compass ingestion demo

This is a real-data base layer for the VC-sourcing challenge. It ingests public signals from GitHub, Hacker News, arXiv, and the `yc-oss` company-data mirror, retaining a source URL for every row.

## Run it

```bash
cd /Users/prashastisrivastava/Documents/Codex/2026-07-18/ps/outputs
python3 -m pip install requests pandas
python3 ingest.py
```

For much more GitHub API headroom, use a fine-grained GitHub token with read-only public access:

```bash
export GITHUB_TOKEN='your-token'
python3 ingest.py --limit 50
```

The two files appear in `data/`:

- `signals.csv`: raw evidence with source, URL, date, and source reliability.
- `founders.csv`: conservative deduplication of public people/handle candidates.

`founders.csv` is intentionally named to match the requested schema, but should be presented in the app as **people candidates**. A GitHub account, HN author, or paper author is not proof that someone is a founder. Exact normalized names/handles are the only automatic merge rule; ambiguous identities require manual verification.

## What to demo

1. Run ingestion once and import both CSVs into your Lovable/Supabase tables.
2. In the UI show each person’s evidence cards and source badges; do not display an unsupported founder label.
3. Score the three axes separately: `Founder`, `Market`, and `Traction`, each with evidence links and an uncertainty band.
4. Make the judge moment a live contradiction: show an AI-generated claim, its linked evidence, and a validator that flags the mismatch rather than silently averaging it away.

For a live refresh, call Tavily only after a judge searches for a specific person/company. Store the returned URLs and timestamp as fresh evidence; do not present an unverified search result as fact.
