# /// script
# requires-python = ">=3.12"
# dependencies = ["pandas", "pyarrow", "fsspec", "aiohttp", "requests"]
# ///
"""Samples the public EN/FR eval sets into bench/datasets/public/*.jsonl (fixed seed).

Run: uv run bench/datasets/prepare.py

Every row is {"id", "lang", "state", "gold"}. Parallel corpora (MASSIVE, XNLI, PAWS-X) use the
same item ids in both languages, so the EN-FR gap compares translations of the same items.
Tweet sentiment is not parallel: each language is sampled on its own, label-balanced.
"""

import json
from pathlib import Path

import pandas as pd

SEED = 20261003
PER_LANG = 200
OUT = Path(__file__).parent / "public"
PARQUET = "https://huggingface.co/api/datasets/{repo}/parquet/{config}/test/0.parquet"

# Ten MASSIVE intents with unambiguous, non-overlapping meanings (Choice question with 10 options).
MASSIVE_INTENTS = [
    "alarm_set",
    "weather_query",
    "play_music",
    "calendar_set",
    "datetime_query",
    "email_sendemail",
    "takeaway_order",
    "iot_hue_lightoff",
    "news_query",
    "transport_ticket",
]


def read(repo: str, config: str) -> pd.DataFrame:
    return pd.read_parquet(PARQUET.format(repo=repo, config=config))


def write(name: str, rows: list[dict]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.jsonl"
    with path.open("w", encoding="utf-8", newline="\n") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    counts = pd.Series([row["lang"] for row in rows]).value_counts().to_dict()
    print(f"{path}: {len(rows)} rows {counts}")


def balanced_ids(frame: pd.DataFrame, label: str, total: int) -> list:
    """Index labels sampled as evenly as possible across classes."""
    classes = sorted(frame[label].unique())
    per_class = total // len(classes)
    picked = []
    for position, value in enumerate(classes):
        group = frame[frame[label] == value]
        take = per_class + (1 if position < total - per_class * len(classes) else 0)
        picked.extend(group.sample(n=min(take, len(group)), random_state=SEED).index.tolist())
    return sorted(picked)


def massive() -> None:
    en = read("mteb/amazon_massive_intent", "en").set_index("id")
    fr = read("mteb/amazon_massive_intent", "fr").set_index("id")
    shared = en[en["label"].isin(MASSIVE_INTENTS) & en.index.isin(fr.index)]
    ids = balanced_ids(shared, "label", PER_LANG)
    rows = [
        {"id": f"massive-{item}", "lang": lang, "state": frame.loc[item, "text"], "gold": en.loc[item, "label"]}
        for lang, frame in (("en", en), ("fr", fr))
        for item in ids
    ]
    write("massive", rows)


def xnli() -> None:
    # XNLI's test split is row-aligned across languages.
    en = read("facebook/xnli", "en")
    fr = read("facebook/xnli", "fr")
    ids = balanced_ids(en, "label", PER_LANG)
    names = {0: "entailment", 1: "neutral", 2: "contradiction"}
    rows = [
        {
            "id": f"xnli-{item}",
            "lang": lang,
            "state": {"premise": frame.loc[item, "premise"], "hypothesis": frame.loc[item, "hypothesis"]},
            "gold": names[int(en.loc[item, "label"])],
        }
        for lang, frame in (("en", en), ("fr", fr))
        for item in ids
    ]
    write("xnli", rows)


def pawsx() -> None:
    en = read("google-research-datasets/paws-x", "en").set_index("id")
    fr = read("google-research-datasets/paws-x", "fr").set_index("id")
    # Some translated pairs are empty; keep ids usable in both languages with the same label.
    usable = en[
        en.index.isin(fr.index)
        & (en["sentence1"].str.len() > 0)
        & (en["sentence2"].str.len() > 0)
    ]
    usable = usable[[
        fr.loc[item, "label"] == usable.loc[item, "label"]
        and len(fr.loc[item, "sentence1"]) > 0
        and len(fr.loc[item, "sentence2"]) > 0
        for item in usable.index
    ]]
    ids = balanced_ids(usable, "label", PER_LANG)
    rows = [
        {
            "id": f"pawsx-{item}",
            "lang": lang,
            "state": {"sentence1": frame.loc[item, "sentence1"], "sentence2": frame.loc[item, "sentence2"]},
            "gold": bool(int(en.loc[item, "label"]) == 1),
        }
        for lang, frame in (("en", en), ("fr", fr))
        for item in ids
    ]
    write("pawsx", rows)


def sentiment() -> None:
    rows = []
    for lang, config in (("en", "english"), ("fr", "french")):
        frame = read("cardiffnlp/tweet_sentiment_multilingual", config)
        for item in balanced_ids(frame, "label", PER_LANG):
            # 0 negative, 1 neutral, 2 positive: already the ordinal Score levels.
            rows.append(
                {"id": f"sentiment-{lang}-{item}", "lang": lang, "state": frame.loc[item, "text"], "gold": int(frame.loc[item, "label"])}
            )
    write("sentiment", rows)


if __name__ == "__main__":
    massive()
    xnli()
    pawsx()
    sentiment()
