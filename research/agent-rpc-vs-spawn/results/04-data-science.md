---
test: test-data-science
label: Data Science
domain: Data Science
runtime: 62s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---



# Retail Sales Forecasting: Model Comparison

## Dataset Context
- **3 years of daily data** (~1,095 rows per store×category combination)
- **Features:** date, store_id, product_category, price, promotion_active, weather_temp, day_of_week, holiday_flag
- **Target:** 30-day sales forecast

---

## 1. ARIMA / SARIMA

**How it works here:** Univariate time series model fitted per store×category combination. SARIMA adds seasonal differencing (e.g., weekly s=7, yearly s=365).

**Pros:**
- Well-understood statistical foundation with confidence intervals out of the box
- Excellent at capturing linear trends and fixed seasonality
- No feature engineering needed for the time series component
- Fast to fit on a single series

**Cons:**
- **Cannot natively use exogenous features** like promotion_active, weather_temp, price (SARIMAX can, but becomes unstable with many regressors)
- Must fit a **separate model per store×category pair** — doesn't scale well if you have 50 stores × 20 categories = 1,000 models
- Assumes linear relationships; misses complex interactions (e.g., promotion × holiday × category)
- Struggles with multiple seasonalities (weekly + yearly simultaneously)
- Requires stationary data; differencing can lose information

**Expected MAPE:** 15–25% (retail daily-level data is noisy; SARIMA captures trend/season but misses promotion-driven spikes)

**Implementation Complexity:** 2/5
- `statsmodels` auto_arima or `pmdarima` handles order selection
- But multiplied by the number of series to maintain

**Data Requirements:**
- Minimum ~2 full seasonal cycles (2 years for yearly seasonality) — you have 3, so adequate
- Data must be regularly spaced (no gaps)
- Works with the univariate sales column only (or limited exogenous vars via SARIMAX)

**Training Time:** ~1–5 seconds per series. For 1,000 store×category combos: **~30–90 minutes total** (parallelizable).

---

## 2. XGBoost with Time Features

**How it works here:** Treat forecasting as a supervised regression problem. Engineer features from date (lag values, rolling means, day_of_week, month, week_of_year, days_since_last_promotion, etc.) and use all provided features directly.

**Pros:**
- **Natively uses all 8 features** — price, promotions, weather, holidays all plug in directly
- Captures non-linear interactions (promotion × holiday, weather × category) without manual specification
- **Single global model** across all stores and categories (store_id and product_category as features) — learns cross-series patterns
- Handles missing data gracefully
- Feature importance gives business-interpretable insights ("promotions drive 30% of variance")
- Battle-tested in production; Kaggle M5 competition winner used tree-based methods

**Cons:**
- Requires careful **feature engineering** — lag features, rolling statistics, calendar encodings
- Doesn't inherently understand temporal ordering; you must encode it
- Recursive multi-step forecasting (predicting day 30 requires predictions from days 1–29 as inputs) introduces error accumulation
- No native confidence intervals (need conformal prediction or quantile regression)
- Risk of data leakage if train/test split isn't time-aware

**Expected MAPE:** 10–18% (significantly better than ARIMA due to exogenous feature utilization and cross-learning)

**Implementation Complexity:** 3/5
- Model itself is simple (`xgboost` or `lightgbm`)
- Feature engineering is the heavy lift: lags, rolling windows, interaction terms, proper time-based CV
- Recursive prediction loop needs careful implementation

**Data Requirements:**
- Benefits from **all features provided** — this dataset is ideal for tree-based methods
- Needs enough history for lag features (e.g., 365-day lag needs 1 year of burn-in)
- More data generally = better; 3 years is solid

**Training Time:** Single model for all series: **2–10 minutes** depending on hyperparameter tuning. With full Optuna/Bayesian tuning: ~30–60 minutes.

---

## 3. Prophet (Meta/Facebook)

**How it works here:** Decomposable additive model: trend + weekly seasonality + yearly seasonality + holiday effects + regressors.

**Pros:**
- **Built-in holiday handling** — just pass holiday dates, it models the effect automatically
- Handles multiple seasonalities (weekly + yearly) natively
- Accepts additional regressors (promotion_active, weather_temp, price)
- Produces uncertainty intervals by default
- Robust to missing data and outliers
- Minimal tuning required; good "first model" baseline

**Cons:**
- Assumes **additive or multiplicative** relationships — can't learn complex interactions (promotion × holiday synergy)
- Additional regressors are modeled as linear effects only
- **One model per series** — same scaling problem as ARIMA (1,000 models for 1,000 combos)
- No cross-learning between stores/categories
- Often outperformed by tree-based methods on datasets with rich features
- Can overfit changepoints on noisy daily retail data
- Development has slowed; not as actively maintained

**Expected MAPE:** 12–22% (better than ARIMA due to holiday/regressor support, but can't exploit feature interactions like XGBoost)

**Implementation Complexity:** 1/5
- Easiest to implement: `Prophet().fit(df).predict(future)`
- Adding holidays and regressors is straightforward
- But scaling to many series adds operational complexity

**Data Requirements:**
- Minimum 1 year (for yearly seasonality); 3 years is ideal
- Prefers column format: ds (date), y (target), plus regressor columns
- Tolerant of gaps and outliers

**Training Time:** ~5–15 seconds per series. For 1,000 combos: **~2–4 hours** (parallelizable but heavier than ARIMA per fit).

---

## 4. LSTM Neural Network

**How it works here:** Sequence-to-sequence model that ingests windowed sequences of all features and outputs 30-day predictions.

**Pros:**
- Can theoretically learn **arbitrary non-linear temporal patterns** and long-range dependencies
- Uses all features simultaneously in sequence context
- Single model can handle all stores/categories (with embeddings for categorical features)
- No manual feature engineering for lags/rolling stats — the network learns temporal patterns

**Cons:**
- **Massive overkill for this dataset** — 3 years of daily data (~1K rows per series) is far too small for LSTMs to shine
- Requires extensive hyperparameter tuning: layers, units, dropout, learning rate, sequence length, batch size
- Training is non-deterministic; results vary between runs
- Black box — no interpretability for business stakeholders
- Needs GPU for reasonable training times
- Prone to overfitting on small datasets; requires careful regularization
- Harder to debug when predictions go wrong
- No native uncertainty quantification

**Expected MAPE:** 13–25% (high variance; could match XGBoost with perfect tuning, but more likely underperforms due to limited data)

**Implementation Complexity:** 5/5
- TensorFlow/PyTorch setup, data windowing pipeline, embedding layers for categoricals
- Extensive experimentation needed for architecture
- Deployment and monitoring are significantly more complex

**Data Requirements:**
- Ideally needs **10K+ samples per series** or a very large cross-series dataset to learn well
- Sensitive to scaling/normalization
- Requires fixed-length input sequences (windowing)
- 3 years daily ≈ 1,095 points — **borderline insufficient**

**Training Time:** **1–6 hours** on GPU (with hyperparameter search). On CPU: potentially 12–24+ hours. Plus experimentation iterations.

---

## Summary Table

| Criteria | ARIMA/SARIMA | XGBoost | Prophet | LSTM |
|---|---|---|---|---|
| **Expected MAPE** | 15–25% | 10–18% | 12–22% | 13–25% |
| **Uses all features** | Poorly (SARIMAX) | Fully | Partially (linear) | Fully |
| **Cross-series learning** | No | Yes | No | Possible |
| **Implementation Complexity** | 2/5 | 3/5 | 1/5 | 5/5 |
| **Training Time (all series)** | 30–90 min | 2–60 min | 2–4 hrs | 1–24 hrs |
| **Interpretability** | High | High (SHAP) | High | Low |
| **Confidence Intervals** | Native | Requires extra work | Native | Requires extra work |
| **Scalability** | Poor (per-series) | Excellent (global) | Poor (per-series) | Moderate |

---

## Recommendation: XGBoost with Time Features

**XGBoost is the clear winner for this use case.** Here's why:

1. **Feature utilization:** This dataset's strength is its rich feature set (promotions, weather, price, holidays). XGBoost is the only approach that fully exploits all features and their interactions in a single global model. ARIMA ignores them; Prophet treats them linearly; LSTM needs far more data to learn them.

2. **Global model advantage:** One XGBoost model across all stores and categories means it learns that "promotions boost electronics sales 40% but groceries only 10%" — cross-series knowledge that per-series models (ARIMA, Prophet) can never capture.

3. **Best expected accuracy:** 10–18% MAPE, driven by the ability to model promotion×holiday interactions, weather effects on category-specific demand, and price elasticity.

4. **Production-ready:** Fast training, simple deployment, deterministic predictions, and SHAP values for business stakeholder buy-in ("why did the model predict a spike next Tuesday?").

5. **Practical sweet spot:** Complexity 3/5 is justified by the accuracy gains. The feature engineering effort is a one-time investment that pays off continuously.

**Suggested implementation plan:**
- Use **LightGBM** (faster, comparable accuracy) as the tree framework
- Engineer 30–50 features: lags (7, 14, 28, 365 days), rolling means/stds (7/14/28-day windows), price ratios, promotion recency, holiday proximity
- Use **time-based cross-validation** (expanding window) — never random splits
- Add **Prophet as a baseline** (complexity 1/5, quick to stand up) to validate XGBoost's lift
- Use **quantile regression** in LightGBM for prediction intervals if needed