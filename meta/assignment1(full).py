"""
CSE Assignment 1: Goodreads recommender tasks

Run every task:        python assignment1.py
Run selected tasks:    python assignment1.py 1 3 6

Each task reads its own CSV files from DATA_DIR and writes task_X_predictions.csv.

Layout
  0. Setup: imports and constants
  1. Shared helpers: similarity, BPR, fake-book sampling, models
  2. Rating pipeline (Tasks 1 and 3)
  3. Interaction pipeline (Tasks 2 and 4)
  4. Task 5: next-book prediction
  5. Task 6: time delta prediction
  6. Run
"""

# =============================================================================
# 0. SETUP
# =============================================================================

import sys
import math
from bisect import bisect_left, bisect_right
from collections import defaultdict

import joblib
import numpy as np
import pandas as pd
import scipy.sparse
from implicit import bpr
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import GroupKFold, KFold, cross_val_predict, cross_val_score
from surprise import SVD, Dataset, Reader

DATA_DIR = "./"
SEED = 42

# Ratings in this dataset run from 0 to 5 (Surprise defaults to 1 to 5)
RATING_READER = Reader(rating_scale=(0, 5))

# Some timestamps are impossible (e.g. year 3645), so time features only trust this window
TIME_MIN = pd.Timestamp("1970-01-01").timestamp()
TIME_MAX = pd.Timestamp("2018-01-01").timestamp()


def load(name):
    return pd.read_csv(DATA_DIR + "/" + name)


# =============================================================================
# 1. SHARED HELPERS
# =============================================================================

def jaccard(a, b):
    """Shared readers divided by all readers of either book."""
    union = len(a | b)
    return len(a & b) / union if union else 0


def cosine(a, b):
    """Shared readers, scaled by the size of each book's audience."""
    if not a or not b:
        return 0
    return len(a & b) / math.sqrt(len(a) * len(b))


def fit_bpr(train_df):
    """Train Bayesian Personalized Ranking on a user-by-book interaction matrix."""
    user_ids = {u: n for n, u in enumerate(train_df["user"].unique())}
    item_ids = {i: n for n, i in enumerate(train_df["item"].unique())}

    rows = train_df["user"].map(user_ids).values
    cols = train_df["item"].map(item_ids).values

    matrix = scipy.sparse.csr_matrix(
        (np.ones(len(train_df)), (rows, cols)),
        shape=(len(user_ids), len(item_ids)),
    )
    matrix.data[:] = 1  # repeated interactions still count once

    model = bpr.BayesianPersonalizedRanking(factors=5, random_state=SEED)
    model.fit(matrix)
    return model, user_ids, item_ids


def bpr_score(bpr_bundle, user, item):
    model, user_ids, item_ids = bpr_bundle
    if user not in user_ids or item not in item_ids:
        return np.nan
    return np.dot(model.user_factors[user_ids[user]], model.item_factors[item_ids[item]])


def make_unread_sampler(df, seed=SEED):
    """
    Returns a function that picks a book the user never read.
    Books are drawn in proportion to popularity, so fake books aren't
    trivially obscure (uniform sampling made popularity a giveaway).
    """
    all_items = df["item"].values
    items_by_user = df.groupby("user")["item"].apply(set).to_dict()
    rng = np.random.default_rng(seed)

    def sample(user):
        seen = items_by_user[user]
        while True:
            item = all_items[rng.integers(len(all_items))]
            if item not in seen:
                return item

    return sample


def pair_accuracy(stack, column):
    """Share of real/fake pairs where the real book scores strictly higher."""
    real = stack[stack["label"] == 1].set_index("pair_id")[column]
    fake = stack[stack["label"] == 0].set_index("pair_id")[column]
    return (real > fake.loc[real.index]).mean()


def make_regressor(loss="squared_error"):
    return HistGradientBoostingRegressor(
        loss=loss,
        learning_rate=0.05,
        max_iter=300,
        max_leaf_nodes=15,
        l2_regularization=1.0 if loss == "squared_error" else 0.0,
        random_state=SEED,
    )


def make_classifier():
    return HistGradientBoostingClassifier(
        learning_rate=0.05,
        max_iter=300,
        max_leaf_nodes=15,
        l2_regularization=1.0,
        random_state=SEED,
    )


# =============================================================================
# 2. RATING PIPELINE (TASKS 1 AND 3)
# Stack: SVD prediction + user/book stats + similarity -> gradient boosting
# =============================================================================

def fit_svd_models(train_df):
    """Base model: SVD latent factor model, settings chosen by grid search."""
    trainset = Dataset.load_from_df(
        train_df[["user", "item", "rating"]], RATING_READER
    ).build_full_trainset()

    models = {"svd": SVD(n_factors=2, n_epochs=40, lr_all=0.003, reg_all=0.03, random_state=SEED)}
    for model in models.values():
        model.fit(trainset)
    return models


def similarity_rating_features(train_df, pred_df):
    """
    sim_rating:   the user's ratings on other books, weighted by each book's
                  Jaccard similarity to the target book
    max_item_sim: similarity to the closest book in the user's history
    """
    users_per_item = defaultdict(set)
    ratings_by_user = defaultdict(dict)

    for user, item, rating in zip(train_df["user"], train_df["item"], train_df["rating"]):
        users_per_item[item].add(user)
        ratings_by_user[user][item] = rating

    sim_ratings, max_sims = [], []

    for user, item in zip(pred_df["user"], pred_df["item"]):
        history = ratings_by_user.get(user, {})
        candidate_users = users_per_item.get(item, set())

        pairs = [
            (jaccard(candidate_users, users_per_item[j]), rating)
            for j, rating in history.items()
            if j != item
        ]
        total_sim = sum(sim for sim, _ in pairs)

        if total_sim > 0:
            sim_ratings.append(sum(sim * rating for sim, rating in pairs) / total_sim)
            max_sims.append(max(sim for sim, _ in pairs))
        else:
            sim_ratings.append(np.nan)
            max_sims.append(0)

    return sim_ratings, max_sims


def rating_base_features(train_df, pred_df, models, keep_cols):
    """User/book stats, base model predictions, and similarity features."""

    def get_stats(column, prefix):
        return train_df.groupby(column)["rating"].agg(
            **{
                f"{prefix}_mean": "mean",
                f"{prefix}_count": "count",
                f"{prefix}_zero_rate": lambda s: (s == 0).mean(),
            }
        ).reset_index()

    features = pred_df[keep_cols].reset_index(drop=True)
    features = features.merge(get_stats("user", "user"), on="user", how="left")
    features = features.merge(get_stats("item", "item"), on="item", how="left")
    features[["user_count", "item_count"]] = features[["user_count", "item_count"]].fillna(0)

    for name, model in models.items():
        features[name] = [
            model.predict(user, item).est
            for user, item in zip(features["user"], features["item"])
        ]

    features["sim_rating"], features["max_item_sim"] = similarity_rating_features(train_df, features)
    return features


def add_time_features(train_df, features):
    """Task 3 time features. Bad dates become missing; stats use valid training rows only."""
    features = features.copy()

    features["timestamp"] = features["timestamp"].where(
        features["timestamp"].between(TIME_MIN, TIME_MAX)
    )
    features["valid_time"] = features["timestamp"].notna().astype(int)
    train_df = train_df[train_df["timestamp"].between(TIME_MIN, TIME_MAX)]

    dates = pd.to_datetime(features["timestamp"], unit="s")
    train_dates = pd.to_datetime(train_df["timestamp"], unit="s")

    # Calendar time
    features["year"] = dates.dt.year
    features["month"] = dates.dt.month
    features["dayofweek"] = dates.dt.dayofweek

    # User and book age, measured from their first training rating
    user_first = train_df.groupby("user")["timestamp"].min()
    book_first = train_df.groupby("item")["timestamp"].min()
    features["user_age"] = features["timestamp"] - features["user"].map(user_first)
    features["book_age"] = features["timestamp"] - features["item"].map(book_first)

    # Time since the user's previous training rating
    user_times = {
        user: np.sort(times.values)
        for user, times in train_df.groupby("user")["timestamp"]
    }

    def get_last_gap(user, timestamp):
        times = user_times.get(user)
        if times is None or pd.isna(timestamp):
            return np.nan
        position = bisect_left(times, timestamp)
        if position == 0:
            return np.nan
        return timestamp - times[position - 1]

    features["last_gap"] = [
        get_last_gap(user, timestamp)
        for user, timestamp in zip(features["user"], features["timestamp"])
    ]

    # Average rating in the same calendar month
    train_periods = train_dates.dt.to_period("M").astype(str)
    period_means = train_df.groupby(train_periods)["rating"].mean()
    features["period_mean"] = dates.dt.to_period("M").astype(str).map(period_means)

    return features


def task1_features(train_df, pred_df, models):
    return rating_base_features(train_df, pred_df, models, ["user", "item"])


def task3_features(train_df, pred_df, models):
    features = rating_base_features(train_df, pred_df, models, ["user", "item", "timestamp"])
    return add_time_features(train_df, features)


TASK1_COLS = [
    "svd",
    "user_mean", "user_count", "user_zero_rate",
    "item_mean", "item_count", "item_zero_rate",
    "sim_rating", "max_item_sim",
]

TASK3_COLS = TASK1_COLS + [
    "year", "month", "dayofweek",
    "user_age", "book_age", "last_gap", "period_mean", "valid_time",
]


def run_rating_task(train_df, test_df, feature_fn, feature_cols, task_num):
    # Out-of-fold stack: each row's features come from models that never saw its rating
    folds = KFold(n_splits=3, shuffle=True, random_state=SEED)
    stack_parts = []

    for train_idx, val_idx in folds.split(train_df):
        fold_train = train_df.iloc[train_idx]
        fold_val = train_df.iloc[val_idx]

        models = fit_svd_models(fold_train)
        fold_features = feature_fn(fold_train, fold_val, models)
        fold_features["rating"] = fold_val["rating"].values
        stack_parts.append(fold_features)

    stack = pd.concat(stack_parts, ignore_index=True)
    stack.to_csv(f"task_{task_num}_stack.csv", index=False)

    X, y = stack[feature_cols], stack["rating"]
    gbm = make_regressor()

    # Validation: SVD alone vs. the stacked model
    scores = cross_val_score(
        gbm, X, y,
        scoring="neg_mean_squared_error",
        cv=KFold(n_splits=3, shuffle=True, random_state=SEED),
    )
    print("SVD MSE:", ((y - stack["svd"]) ** 2).mean())
    print("Stacked MSE:", -scores.mean())

    # Final model: train on everything, then predict the test file
    gbm.fit(X, y)
    final_models = fit_svd_models(train_df)
    test_features = feature_fn(train_df, test_df, final_models)

    output = test_df.copy()
    output["rating"] = np.clip(gbm.predict(test_features[feature_cols]), 0, 5)
    output.to_csv(f"task_{task_num}_predictions.csv", index=False)

    joblib.dump(gbm, f"task_{task_num}_gbm.joblib")
    return output


def run_task1():
    run_rating_task(load("tasks_1_2_train.csv"), load("task_1_test.csv"),
                    task1_features, TASK1_COLS, task_num=1)


def run_task3():
    run_rating_task(load("tasks_3_4_train.csv"), load("task_3_test.csv"),
                    task3_features, TASK3_COLS, task_num=3)


# =============================================================================
# 3. INTERACTION PIPELINE (TASKS 2 AND 4)
# Stack: BPR score + popularity + similarity (+ time) -> gradient boosting classifier
# =============================================================================

def interaction_features(train_df, rows, bpr_bundle):
    """BPR score, popularity, history size, and similarity to the user's past books."""
    users_per_item = defaultdict(set)
    items_per_user = defaultdict(set)

    for user, item in zip(train_df["user"], train_df["item"]):
        users_per_item[item].add(user)
        items_per_user[user].add(item)

    records = []

    for user, item in zip(rows["user"], rows["item"]):
        history = items_per_user.get(user, set()) - {item}
        candidate_users = users_per_item.get(item, set())

        jaccards = [jaccard(candidate_users, users_per_item[j]) for j in history]
        cosines = [cosine(candidate_users, users_per_item[j]) for j in history]

        records.append({
            "bpr": bpr_score(bpr_bundle, user, item),
            "popularity": len(candidate_users),
            "user_count": len(history),
            "max_jaccard": max(jaccards, default=0),
            "avg_jaccard": np.mean(jaccards) if jaccards else 0,
            "max_cosine": max(cosines, default=0),
        })

    return pd.DataFrame(records)


WINDOW = 90 * 24 * 60 * 60  # 90 days, in seconds


def add_interaction_time_features(train_df, rows, features):
    """Task 4 time features. Only interactions before each row's timestamp are used."""
    valid_train = train_df[train_df["timestamp"].between(TIME_MIN, TIME_MAX)].sort_values("timestamp")

    item_times = {item: times.values for item, times in valid_train.groupby("item")["timestamp"]}
    user_history = {
        user: (group["timestamp"].values, group["item"].values)
        for user, group in valid_train.groupby("user")
    }
    users_per_item = valid_train.groupby("item")["user"].apply(set).to_dict()

    timestamps = rows["timestamp"].where(rows["timestamp"].between(TIME_MIN, TIME_MAX))
    records = []

    for user, item, timestamp in zip(rows["user"], rows["item"], timestamps):
        record = {
            "valid_time": int(pd.notna(timestamp)),
            "recent_popularity": 0,
            "popularity_before": 0,
            "book_seen_yet": 0,
            "book_age": np.nan,
            "item_last_gap": np.nan,
            "recent_read_sim": 0,
        }

        if pd.notna(timestamp):
            times = item_times.get(item)

            if times is not None:
                position = bisect_left(times, timestamp)
                window_start = bisect_left(times, timestamp - WINDOW)

                record["popularity_before"] = position
                record["recent_popularity"] = position - window_start
                record["book_seen_yet"] = int(times[0] <= timestamp)
                record["book_age"] = timestamp - times[0]
                if position > 0:
                    record["item_last_gap"] = timestamp - times[position - 1]

            history = user_history.get(user)

            if history is not None:
                user_times, user_items = history
                position = bisect_left(user_times, timestamp)
                recent_items = user_items[max(0, position - 5):position]
                candidate_users = users_per_item.get(item, set())

                sims = [
                    jaccard(candidate_users, users_per_item[j])
                    for j in recent_items
                    if j != item
                ]
                record["recent_read_sim"] = max(sims, default=0)

        records.append(record)

    return pd.concat([features.reset_index(drop=True), pd.DataFrame(records)], axis=1)


def task2_features(train_df, rows, bpr_bundle):
    return interaction_features(train_df, rows, bpr_bundle)


def task4_features(train_df, rows, bpr_bundle):
    features = interaction_features(train_df, rows, bpr_bundle)
    return add_interaction_time_features(train_df, rows, features)


TASK2_COLS = [
    "bpr", "popularity", "user_count",
    "max_jaccard", "avg_jaccard", "max_cosine",
]

TASK4_COLS = TASK2_COLS + [
    "valid_time", "recent_popularity", "popularity_before",
    "book_seen_yet", "book_age", "item_last_gap", "recent_read_sim",
]


def make_pair_rows(real_df, sampler, pair_ids, with_timestamp):
    """Each real interaction (label 1) is paired with an unread book (label 0)."""
    real = {"user": real_df["user"].values, "item": real_df["item"].values}
    fake = {"user": real_df["user"].values, "item": [sampler(u) for u in real_df["user"]]}

    if with_timestamp:
        # The fake book shares the real row's timestamp, so time alone can't give it away
        real["timestamp"] = fake["timestamp"] = real_df["timestamp"].values

    real = pd.DataFrame(real).assign(label=1, pair_id=pair_ids)
    fake = pd.DataFrame(fake).assign(label=0, pair_id=pair_ids)
    return pd.concat([real, fake], ignore_index=True)


def score_stack(stack, feature_cols, report_cols):
    """Out-of-fold probabilities, grouped so a pair never splits across folds."""
    clf = make_classifier()
    stack["proba"] = cross_val_predict(
        clf, stack[feature_cols], stack["label"],
        groups=stack["pair_id"],
        cv=GroupKFold(n_splits=3),
        method="predict_proba",
    )[:, 1]

    for col in report_cols + ["proba"]:
        print(f"{col} accuracy:", pair_accuracy(stack, col))
    return clf


def predict_pairs(clf, train_df, test_df, feature_fn, feature_cols, bpr_bundle, with_timestamp):
    """Score item1 and item2 for each test row and keep the more likely one."""

    def score(column):
        rows = pd.DataFrame({"user": test_df["user"], "item": test_df[column]})
        if with_timestamp:
            rows["timestamp"] = test_df["timestamp"]
        features = feature_fn(train_df, rows, bpr_bundle)
        return clf.predict_proba(features[feature_cols])[:, 1]

    score1, score2 = score("item1"), score("item2")
    output = test_df.copy()
    output["which"] = np.where(score1 >= score2, output["item1"], output["item2"])
    return output


def run_interaction_task(train_df, test_df, feature_fn, feature_cols, task_num,
                         with_timestamp, report_cols):
    sampler = make_unread_sampler(train_df)
    folds = KFold(n_splits=3, shuffle=True, random_state=SEED)
    stack_parts = []
    next_pair = 0

    for train_idx, val_idx in folds.split(train_df):
        fold_train = train_df.iloc[train_idx]
        fold_val = train_df.iloc[val_idx]
        pair_ids = np.arange(next_pair, next_pair + len(fold_val))
        next_pair += len(fold_val)

        fold_rows = make_pair_rows(fold_val, sampler, pair_ids, with_timestamp)
        bpr_bundle = fit_bpr(fold_train)

        fold_features = feature_fn(fold_train, fold_rows, bpr_bundle)
        fold_features["label"] = fold_rows["label"]
        fold_features["pair_id"] = fold_rows["pair_id"]
        stack_parts.append(fold_features)

    stack = pd.concat(stack_parts, ignore_index=True)
    stack.to_csv(f"task_{task_num}_stack.csv", index=False)

    clf = score_stack(stack, feature_cols, report_cols)
    clf.fit(stack[feature_cols], stack["label"])

    final_bpr = fit_bpr(train_df)
    output = predict_pairs(clf, train_df, test_df, feature_fn, feature_cols, final_bpr, with_timestamp)
    output.to_csv(f"task_{task_num}_predictions.csv", index=False)

    joblib.dump(clf, f"task_{task_num}_clf.joblib")
    return output


def run_task2():
    run_interaction_task(load("tasks_1_2_train.csv"), load("task_2_test.csv"),
                         task2_features, TASK2_COLS, task_num=2,
                         with_timestamp=False, report_cols=["bpr", "popularity"])


def run_task4():
    run_interaction_task(load("tasks_3_4_train.csv"), load("task_4_test.csv"),
                         task4_features, TASK4_COLS, task_num=4,
                         with_timestamp=True, report_cols=["bpr", "popularity", "recent_popularity"])


# =============================================================================
# 4. TASK 5: NEXT-BOOK PREDICTION
# Task 2 features + transitions from the user's latest book.
# Validation holds out each user's last book, matching the test.
# =============================================================================

def add_sequence_features(history_df, rows, features):
    ordered = history_df.sort_values(["user", "timestamp"], kind="stable")

    transitions = defaultdict(lambda: defaultdict(int))  # transitions[a][b]: readers who went a -> b
    totals = defaultdict(int)                             # totals[a]: books that followed a
    recent = {}                                           # each user's last five books

    for user, group in ordered.groupby("user", sort=False):
        items = group["item"].tolist()
        for a, b in zip(items, items[1:]):
            transitions[a][b] += 1
            totals[a] += 1
        recent[user] = items[-5:]

    users_per_item = ordered.groupby("item")["user"].apply(set).to_dict()
    records = []

    for user, item in zip(rows["user"], rows["item"]):
        r = {
            "trans_count": 0, "trans_rate": np.nan,
            "last_jaccard": 0, "last_cosine": 0, "recent_max_jaccard": 0,
        }
        last5 = recent.get(user, [])

        if last5:
            last = last5[-1]
            candidate_users = users_per_item.get(item, set())
            last_users = users_per_item.get(last, set())

            r["trans_count"] = transitions[last].get(item, 0)
            if totals[last]:
                r["trans_rate"] = r["trans_count"] / totals[last]

            r["last_jaccard"] = jaccard(candidate_users, last_users)
            r["last_cosine"] = cosine(candidate_users, last_users)
            r["recent_max_jaccard"] = max(
                (jaccard(candidate_users, users_per_item.get(j, set())) for j in last5),
                default=0,
            )

        records.append(r)

    return pd.concat([features.reset_index(drop=True), pd.DataFrame(records)], axis=1)


def task5_features(history_df, rows, bpr_bundle):
    features = interaction_features(history_df, rows, bpr_bundle)
    return add_sequence_features(history_df, rows, features)


TASK5_COLS = TASK2_COLS + [
    "trans_count", "trans_rate",
    "last_jaccard", "last_cosine", "recent_max_jaccard",
]


def run_task5():
    df = load("task_5_train.csv")
    test_df = load("task_5_test.csv")

    # Bad dates would scramble reading order, so drop them before sorting
    df = df[df["timestamp"].between(TIME_MIN, TIME_MAX)]
    df = df.sort_values(["user", "timestamp"], kind="stable").reset_index(drop=True)

    # Each user's last book is the "next book" to predict; earlier books are history
    counts = df.groupby("user")["item"].transform("size")
    last_idx = df[counts >= 2].groupby("user").tail(1).index
    val_real = df.loc[last_idx]
    history_df = df.drop(last_idx)

    sampler = make_unread_sampler(df)
    val_rows = make_pair_rows(val_real, sampler, np.arange(len(val_real)), with_timestamp=False)

    stack = task5_features(history_df, val_rows, fit_bpr(history_df))
    stack["label"] = val_rows["label"]
    stack["pair_id"] = val_rows["pair_id"]
    stack.to_csv("task_5_stack.csv", index=False)

    clf = score_stack(stack, TASK5_COLS, ["bpr", "popularity", "trans_count", "last_jaccard"])
    clf.fit(stack[TASK5_COLS], stack["label"])

    # For the test, the full training history ends right before the predicted book
    output = predict_pairs(clf, df, test_df, task5_features, TASK5_COLS, fit_bpr(df), with_timestamp=False)
    output.to_csv("task_5_predictions.csv", index=False)
    print("Missing predictions:", output["which"].isna().sum())

    joblib.dump(clf, "task_5_clf.joblib")


# =============================================================================
# 5. TASK 6: TIME DELTA PREDICTION
# Regression on the user's past pace. Validation holds out each user's last known gap.
# =============================================================================

MONTH = 30 * 24 * 60 * 60  # seconds


def gap_features(history_df, rows):
    """Pace features using only the user's interactions at or before each row's time."""
    user_times = {u: np.sort(t.values) for u, t in history_df.groupby("user")["timestamp"]}
    item_times = {i: np.sort(t.values) for i, t in history_df.groupby("item")["timestamp"]}
    records = []

    for user, item, ts in zip(rows["user"], rows["item"], rows["timestamp"]):
        r = {
            "user_count": 0, "time_on_site": np.nan, "per_month": np.nan,
            "median_gap": np.nan, "mean_gap": np.nan, "std_gap": np.nan,
            "last_gap": np.nan, "recent_median_gap": np.nan,
            "month": np.nan, "item_popularity": 0,
        }

        if pd.notna(ts):
            r["month"] = pd.to_datetime(ts, unit="s").month
            times = user_times.get(user)

            if times is not None:
                pos = bisect_right(times, ts)  # everything after pos is in the future

                if pos > 0:
                    r["user_count"] = pos
                    r["time_on_site"] = ts - times[0]
                    r["per_month"] = pos / (r["time_on_site"] / MONTH + 1)

                    gaps = np.diff(times[max(0, pos - 200):pos])  # last 200 keeps it fast
                    if len(gaps):
                        r["median_gap"] = np.median(gaps)
                        r["mean_gap"] = gaps.mean()
                        r["std_gap"] = gaps.std()
                        r["last_gap"] = gaps[-1]
                        r["recent_median_gap"] = np.median(gaps[-5:])

            if item in item_times:
                r["item_popularity"] = bisect_right(item_times[item], ts)

        records.append(r)

    return pd.DataFrame(records)


TASK6_COLS = [
    "user_count", "time_on_site", "per_month",
    "median_gap", "mean_gap", "std_gap",
    "last_gap", "recent_median_gap",
    "month", "item_popularity",
]


def run_task6():
    df = load("task_6_train.csv")
    test_df = load("task_6_test.csv")

    # Target: time until the user's next interaction. Bad dates can't give a real gap.
    df = df[df["timestamp"].between(TIME_MIN, TIME_MAX)]
    df = df.sort_values(["user", "timestamp"]).reset_index(drop=True)
    df["delta"] = df.groupby("user")["timestamp"].shift(-1) - df["timestamp"]
    df["next_item"] = df.groupby("user")["item"].shift(-1)

    # The test's item is the next book, so training rows use the next book too
    has_next = df[df["delta"].notna()]
    val_idx = has_next.groupby("user")["timestamp"].idxmax()
    val_rows = has_next.loc[val_idx].assign(item=lambda d: d["next_item"])
    train_rows = has_next.drop(val_idx).assign(item=lambda d: d["next_item"])
    has_next = has_next.assign(item=lambda d: d["next_item"])

    # Validation: compare against simple median guesses
    X_train, X_val = gap_features(df, train_rows), gap_features(df, val_rows)
    y_train, y_val = train_rows["delta"].values, val_rows["delta"].values

    global_median = np.median(y_train)
    print("Global median MAE:", mean_absolute_error(y_val, np.full(len(y_val), global_median)))
    print("User median MAE:", mean_absolute_error(y_val, X_val["median_gap"].fillna(global_median)))

    gap_model = make_regressor(loss="absolute_error")  # a few huge gaps would skew squared error
    gap_model.fit(X_train[TASK6_COLS], y_train)
    print("Model MAE:", mean_absolute_error(y_val, gap_model.predict(X_val[TASK6_COLS])))

    # Final model. Test rows have no timestamp, so measure from each user's last interaction.
    gap_model.fit(gap_features(df, has_next)[TASK6_COLS], has_next["delta"].values)

    test_rows = test_df[["user", "item"]].copy()
    test_rows["timestamp"] = test_rows["user"].map(df.groupby("user")["timestamp"].max())

    output = test_df.copy()
    output["delta"] = np.maximum(gap_model.predict(gap_features(df, test_rows)[TASK6_COLS]), 0)
    output.to_csv("task_6_predictions.csv", index=False)
    print("Missing deltas:", output["delta"].isna().sum())

    joblib.dump(gap_model, "task_6_gap_model.joblib")


# =============================================================================
# 6. RUN
# =============================================================================

TASKS = {1: run_task1, 2: run_task2, 3: run_task3, 4: run_task4, 5: run_task5, 6: run_task6}

if __name__ == "__main__":
    selected = [int(arg) for arg in sys.argv[1:]] or sorted(TASKS)
    for task_num in selected:
        print(f"\n===== Task {task_num} =====")
        TASKS[task_num]()