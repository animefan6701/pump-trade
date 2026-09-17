#!/usr/bin/env python3
"""Train survive-70 and hit-1.5x from live migrate lock snapshots only.

One row per mint. X = coins.migrateFeatures at lock (+ logMc, heldEntry).
y = migrateSurvive70 / migrateHit15x.

Never reads:
  - Mongo source melt/dump
  - models/entry_labels.json
  - curve_outcomes / dump graduate-fail
  - vendor/melt feature.pkl
Does not retrain rug, entry, MELT, dir5m, hit2x, or dumpFirst.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xgboost as xgb
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"

# Lock-snapshot numerics persisted on coins.migrateFeatures at first PumpSwap lock.
LOCK_FEATURES = [
    "logMc",
    "liq",
    "vol5",
    "vol1h",
    "ch5",
    "ch1",
    "athRatio",
    "ageMin",
    "holders",
    "top10",
    "buyers5m",
    "sellers5m",
    "devHold",
    "replies",
    "gini",
    "creatorSold",
    "modelUsed",
    "modelMissing",
    "sniperSeen",
    "group4",
    "group4n",
    "jito",
    "trades",
    "unique",
    "wash",
    "sellPressure",
    "heldEntry",
    "bonding",
    "bundle",
]

BLOCKED_SOURCES = {"melt", "dump", "entry_labels", "curve_outcomes"}


def load_env() -> None:
    for path in (ROOT / "web" / ".env", ROOT / ".env", ROOT / "web" / ".env.local"):
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def num(v) -> float | None:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)) and math.isfinite(float(v)):
        return float(v)
    return None


def lock_row(doc: dict) -> dict[str, float | None] | None:
    feats = doc.get("migrateFeatures")
    if not isinstance(feats, dict) or not feats:
        return None
    mc = num(doc.get("migrateMc")) or num(feats.get("mc"))
    if not (mc and mc > 0):
        return None
    out: dict[str, float | None] = {name: None for name in LOCK_FEATURES}
    out["logMc"] = math.log1p(mc)
    held = num(doc.get("migrateEntryProb"))
    out["heldEntry"] = held
    for name in LOCK_FEATURES:
        if name in ("logMc", "heldEntry"):
            continue
        out[name] = num(feats.get(name))
    filled = sum(1 for name in LOCK_FEATURES if out[name] is not None)
    if filled < 8:
        return None
    return out


def mint_split(mint: str) -> str:
    h = 0
    for ch in mint:
        h = (h * 33 + ord(ch)) & 0xFFFFFFFF
    return "test" if h % 4 == 0 else "train"


def convert_tree(node: dict, feat_names: list[str]) -> dict:
    if "leaf" in node:
        return {"leaf": float(node["leaf"])}
    split = node.get("split")
    if isinstance(split, str) and split in feat_names:
        f = feat_names.index(split)
    elif isinstance(split, str) and split.startswith("f") and split[1:].isdigit():
        f = int(split[1:])
    else:
        f = int(node.get("split_index", 0))
    children = {c["nodeid"]: c for c in node.get("children", [])}
    yes = children[node["yes"]]
    no = children[node["no"]]
    missing = node.get("missing", node["yes"])
    return {
        "f": f,
        "thr": float(node["split_condition"]),
        "left": convert_tree(yes, feat_names),
        "right": convert_tree(no, feat_names),
        "miss": "left" if missing == node["yes"] else "right",
    }


def walk(node: dict, x: list[float]) -> float:
    if "leaf" in node:
        return float(node["leaf"])
    v = x[node["f"]]
    if isinstance(v, float) and math.isnan(v):
        go_left = node.get("miss") != "right"
    else:
        go_left = v < node["thr"]
    child = node["left"] if go_left else node["right"]
    return walk(child, x)


def sigmoid(z: float) -> float:
    if z >= 0:
        e = math.exp(-z)
        return 1.0 / (1.0 + e)
    e = math.exp(z)
    return e / (1.0 + e)


def base_score_logit(clf: xgb.XGBClassifier) -> float:
    cfg = json.loads(clf.get_booster().save_config())
    raw = cfg.get("learner", {}).get("learner_model_param", {}).get("base_score")
    if raw is None:
        return 0.0
    if isinstance(raw, str):
        raw = raw.strip()
        if raw.startswith("["):
            raw = raw.strip("[]").split(",")[0]
        try:
            val = float(raw)
        except ValueError:
            return 0.0
    else:
        val = float(raw)
    if 0.0 < val < 1.0:
        return math.log(val / (1.0 - val))
    return val


def json_predict(model: dict, X: np.ndarray) -> np.ndarray:
    out = []
    med = model["medians"]
    for row in X:
        x = []
        for i, v in enumerate(row):
            if isinstance(v, float) and math.isnan(v):
                x.append(float(med[i]))
            else:
                x.append(float(v))
        margin = float(model.get("base_score") or 0.0)
        for tree in model["trees"]:
            margin += walk(tree, x)
        out.append(min(0.999, max(0.001, sigmoid(margin))))
    return np.array(out, dtype=float)


def pr_auc(y: np.ndarray, p: np.ndarray) -> float:
    if y.sum() == 0 or y.sum() == len(y):
        return float(y.mean())
    order = np.argsort(-p)
    ys = y[order]
    tp = np.cumsum(ys)
    fp = np.cumsum(1 - ys)
    rec = tp / ys.sum()
    prec = tp / np.maximum(tp + fp, 1)
    rec = np.concatenate([[0.0], rec])
    prec = np.concatenate([[1.0], prec])
    return float(np.trapezoid(prec, rec))


def roc_auc(y: np.ndarray, p: np.ndarray) -> float:
    if y.sum() == 0 or y.sum() == len(y):
        return 0.5
    order = np.argsort(p)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, len(p) + 1)
    n_pos = float(y.sum())
    n_neg = float(len(y) - n_pos)
    return float((ranks[y == 1].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def pick_threshold(y: np.ndarray, p: np.ndarray, floor: float, cap: float) -> float:
    best_t, best_f1 = 0.55, -1.0
    for t in np.linspace(floor, cap, 26):
        pred = (p >= t).astype(int)
        tp = float(((pred == 1) & (y == 1)).sum())
        fp = float(((pred == 1) & (y == 0)).sum())
        fn = float(((pred == 0) & (y == 1)).sum())
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        if f1 > best_f1:
            best_f1, best_t = f1, float(t)
    return round(best_t, 3)


def at_cut(y: np.ndarray, p: np.ndarray, t: float) -> dict:
    pred = (p >= t).astype(int)
    tp = float(((pred == 1) & (y == 1)).sum())
    fp = float(((pred == 1) & (y == 0)).sum())
    tn = float(((pred == 0) & (y == 0)).sum())
    fn = float(((pred == 0) & (y == 1)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return {
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1": round(2 * prec * rec / (prec + rec) if prec + rec else 0.0, 4),
        "acc": round((tp + tn) / max(len(y), 1), 4),
        "flag_rate": round(float(pred.mean()), 4),
    }


def fit_head(name: str, X: np.ndarray, y: np.ndarray, mints: list[str], label: str) -> dict:
    split = np.array([mint_split(m) for m in mints])
    tr = split == "train"
    te = split == "test"
    if tr.sum() < 80 or te.sum() < 30 or y[tr].sum() < 20 or y[te].sum() < 8:
        raise SystemExit(f"{name}: split too thin train={int(tr.sum())} test={int(te.sum())}")

    medians = []
    for i in range(X.shape[1]):
        col = X[tr, i]
        finite = col[np.isfinite(col)]
        medians.append(float(np.median(finite)) if len(finite) else 0.0)
    medians_arr = np.array(medians, dtype=float)
    Xtr = np.where(np.isfinite(X[tr]), X[tr], medians_arr)
    Xte = np.where(np.isfinite(X[te]), X[te], medians_arr)
    ytr, yte = y[tr], y[te]
    pos = float(ytr.mean())
    neg, npos = float((ytr == 0).sum()), float(ytr.sum())
    spw = neg / max(npos, 1.0)

    clf = xgb.XGBClassifier(
        n_estimators=80,
        max_depth=4,
        learning_rate=0.08,
        subsample=0.85,
        colsample_bytree=0.8,
        min_child_weight=6,
        reg_lambda=2.0,
        objective="binary:logistic",
        eval_metric="logloss",
        scale_pos_weight=spw,
        n_jobs=4,
        random_state=7,
    )
    clf.fit(Xtr, ytr)
    p_tr = clf.predict_proba(Xtr)[:, 1]
    p_te = clf.predict_proba(Xte)[:, 1]
    trees = [
        convert_tree(json.loads(raw), LOCK_FEATURES)
        for raw in clf.get_booster().get_dump(dump_format="json")
    ]
    model = {
        "kind": "xgb",
        "features": LOCK_FEATURES,
        "medians": [round(m, 6) for m in medians],
        "base_score": base_score_logit(clf),
        "trees": trees,
        "threshold": 0.55,
        "metrics": {},
        "label": label,
        "source": "live-lock",
        "trainedAt": datetime.now(timezone.utc).isoformat(),
    }
    chk = json_predict(model, Xte[: min(40, len(Xte))])
    err = float(np.max(np.abs(chk - p_te[: len(chk)])))
    print(json.dumps({"walker_max_abs": round(err, 6)}, indent=2))
    if err > 0.02:
        raise SystemExit(f"{name}: JSON walker mismatch vs XGB predict_proba ({err})")

    floor, cap = (0.48, 0.70) if name == "survive70" else (0.40, 0.65)
    thr = pick_threshold(yte, p_te, floor, cap)
    model["threshold"] = thr
    cut = at_cut(yte, p_te, thr)
    model["metrics"] = {
        "n": int(len(y)),
        "n_train": int(tr.sum()),
        "n_test": int(te.sum()),
        "pos_rate": round(float(y.mean()), 4),
        "pos_rate_test": round(float(yte.mean()), 4),
        "auprc_test": round(pr_auc(yte, p_te), 4),
        "auc_test": round(roc_auc(yte, p_te), 4),
        "brier_test": round(float(np.mean((p_te - yte) ** 2)), 4),
        "brier_train": round(float(np.mean((p_tr - ytr) ** 2)), 4),
        "threshold": thr,
        **{f"test_{k}": v for k, v in cut.items()},
    }
    path = MODELS / f"{name}.json"
    path.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"wrote": str(path), **model["metrics"]}, indent=2))
    return model


def load_live_locks(db) -> list[dict]:
    q = {
        "source": "live",
        "migrateOutcomeAt": {"$exists": True, "$nin": [None, ""]},
        "migrateFeatures": {"$exists": True, "$type": "object"},
        "migrateSurvive70": {"$in": [True, False]},
        "migrateHit15x": {"$in": [True, False]},
        "migrateMc": {"$gt": 0},
    }
    proj = {
        "mint": 1,
        "source": 1,
        "migrateFeatures": 1,
        "migrateMc": 1,
        "migrateEntryProb": 1,
        "migrateSurvive70": 1,
        "migrateHit15x": 1,
        "labelSource": 1,
    }
    rows = []
    skipped = {"source": 0, "feats": 0}
    for doc in db["coins"].find(q, proj):
        src = str(doc.get("source") or "").lower()
        label_src = str(doc.get("labelSource") or "").lower()
        if src in BLOCKED_SOURCES or label_src in BLOCKED_SOURCES:
            skipped["source"] += 1
            continue
        row = lock_row(doc)
        if not row:
            skipped["feats"] += 1
            continue
        rows.append(
            {
                "mint": doc["mint"],
                "x": row,
                "survive70": 1 if doc.get("migrateSurvive70") else 0,
                "hit15x": 1 if doc.get("migrateHit15x") else 0,
            }
        )
    print(json.dumps({"loaded": len(rows), "skipped": skipped}, indent=2))
    return rows


def pack(rows: list[dict]) -> tuple[np.ndarray, list[str]]:
    X = np.array(
        [[r["x"][name] if r["x"][name] is not None else np.nan for name in LOCK_FEATURES] for r in rows],
        dtype=float,
    )
    return X, [r["mint"] for r in rows]


def score_live(db, survive: dict, hit: dict) -> None:
    q = {
        "source": "live",
        "migrateFeatures": {"$exists": True, "$type": "object"},
        "migrateMc": {"$gt": 0},
    }
    n = 0
    for doc in db["coins"].find(q, {"mint": 1, "migrateFeatures": 1, "migrateMc": 1, "migrateEntryProb": 1}):
        row = lock_row(doc)
        if not row:
            continue
        x = np.array([[row[name] if row[name] is not None else np.nan for name in LOCK_FEATURES]], dtype=float)
        s70 = float(json_predict(survive, x)[0])
        h15 = float(json_predict(hit, x)[0])
        db["coins"].update_one(
            {"mint": doc["mint"], "source": "live"},
            {"$set": {"survive70Prob": s70, "hit15xProb": h15}},
        )
        n += 1
    print(json.dumps({"backfilled": n}, indent=2))


def main() -> None:
    load_env()
    uri = os.environ.get("MONGODB_URI") or "mongodb://127.0.0.1:27017"
    db_name = os.environ.get("MONGODB_DB") or "pump_trade"
    client = MongoClient(uri)
    db = client[db_name]
    rows = load_live_locks(db)
    if len(rows) < 200:
        raise SystemExit(f"need >=200 live lock rows, got {len(rows)}")
    X, mints = pack(rows)
    y70 = np.array([r["survive70"] for r in rows], dtype=float)
    y15 = np.array([r["hit15x"] for r in rows], dtype=float)
    print(json.dumps({"db": db_name, "features": LOCK_FEATURES, "n": len(rows)}, indent=2))
    survive = fit_head(
        "survive70",
        X,
        y70,
        mints,
        "flag - P(minMc/lock >= 0.7 at 20m | migrate lock snapshot)",
    )
    hit = fit_head(
        "hit15x",
        X,
        y15,
        mints,
        "flag - P(maxMc >= lock * 1.5 | migrate lock snapshot)",
    )
    score_live(db, survive, hit)
    client.close()


if __name__ == "__main__":
    main()
