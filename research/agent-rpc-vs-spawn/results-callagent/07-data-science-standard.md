---
test_name: sales-forecasting-models
domain: Data Science
mode: standard (async)
runtime: ~53s
method: AgenticMail Call Agent
output_format: Structured JSON
---

# Sales Forecasting Model Comparison

**Mode:** `standard` (async — fire-and-forget, agent notified on completion).

## Result

```json
{
  "status": "completed",
  "task_id": "sales-forecasting-models",
  "mode": "standard",
  "async": true,
  "result": {
    "task": "Compare forecasting models for retail sales prediction",
    "data_assumptions": {
      "type": "Weekly retail sales",
      "history": "3-5 years",
      "granularity": "Store-SKU level",
      "features_available": ["promotions", "holidays", "weather", "price", "inventory"],
      "seasonality": "Strong (weekly, monthly, annual)"
    },
    "models": [
      {
        "name": "ARIMA/SARIMA",
        "category": "Classical Statistical",
        "mape_range": "12-18%",
        "complexity": "Low",
        "training_time": "Seconds per series",
        "interpretability": "High",
        "pros": [
          "Well-understood statistical foundations",
          "No feature engineering required",
          "Excellent for univariate series with clear patterns",
          "Fast to train and deploy",
          "Good baseline model"
        ],
        "cons": [
          "Cannot incorporate external regressors easily (SARIMAX is limited)",
          "Assumes linear relationships",
          "Poor with regime changes or structural breaks",
          "Must fit per-series (doesn't share learning across products)",
          "Struggles with intermittent demand (new products)"
        ],
        "best_for": "Stable, high-volume SKUs with clear seasonal patterns"
      },
      {
        "name": "XGBoost (Gradient Boosted Trees)",
        "category": "Machine Learning",
        "mape_range": "8-14%",
        "complexity": "Medium",
        "training_time": "Minutes (single model for all series)",
        "interpretability": "Medium (SHAP values available)",
        "pros": [
          "Handles mixed feature types natively",
          "Captures non-linear relationships and interactions",
          "Feature importance for business insight",
          "Single model across all series (transfer learning effect)",
          "Robust to outliers and missing data",
          "Excellent with promotional/holiday features"
        ],
        "cons": [
          "Requires careful feature engineering (lags, rolling stats, date features)",
          "Recursive multi-step forecasting accumulates error",
          "Hyperparameter tuning needed (but Optuna makes this manageable)",
          "Doesn't natively capture temporal dependencies"
        ],
        "best_for": "Multi-SKU forecasting where external features (promos, weather, price) drive variation"
      },
      {
        "name": "Prophet (Meta)",
        "category": "Decomposition-based",
        "mape_range": "10-16%",
        "complexity": "Low-Medium",
        "training_time": "Seconds per series",
        "interpretability": "High (decomposition plots)",
        "pros": [
          "Automatic changepoint detection",
          "Built-in holiday effects",
          "Intuitive decomposition (trend + seasonality + holidays)",
          "Good documentation and community",
          "Handles missing data gracefully",
          "Easy to add custom regressors"
        ],
        "cons": [
          "Overfits on short time series",
          "Weaker than XGBoost when external features are key drivers",
          "Per-series fitting (like ARIMA)",
          "Can produce unrealistic forecasts at long horizons",
          "Development has slowed (limited active maintenance)"
        ],
        "best_for": "Business teams needing interpretable forecasts with minimal data science expertise"
      },
      {
        "name": "LSTM (Deep Learning)",
        "category": "Neural Network",
        "mape_range": "9-15%",
        "complexity": "High",
        "training_time": "Hours (GPU recommended)",
        "interpretability": "Low",
        "pros": [
          "Learns temporal dependencies automatically",
          "Can capture complex non-linear patterns",
          "Multi-step forecasting native (seq2seq)",
          "Transfer learning across related series possible",
          "Attention mechanisms add some interpretability"
        ],
        "cons": [
          "Requires large dataset (>1000 time steps ideal)",
          "Expensive to train and tune",
          "Prone to overfitting on small datasets",
          "Harder to debug and maintain in production",
          "Often doesn't beat XGBoost on tabular data",
          "Reproducibility challenges"
        ],
        "best_for": "Very large datasets (100K+ series) where deep patterns exist and compute budget is available"
      }
    ],
    "recommendation": {
      "primary": "XGBoost",
      "rationale": "For retail sales forecasting with external features (promotions, holidays, weather, price), XGBoost consistently delivers the best accuracy-to-complexity ratio. It handles the multi-SKU problem with a single model, incorporates external features naturally, and provides feature importance for business stakeholders.",
      "implementation_plan": [
        {
          "step": 1,
          "action": "Feature Engineering",
          "details": "Create lag features (1-52 weeks), rolling statistics (mean, std, min, max over 4/8/12/26/52 weeks), date features (week of year, month, quarter, is_holiday), promotional features (discount %, promo type, days since/until promo)"
        },
        {
          "step": 2,
          "action": "Train/Validation Split",
          "details": "Time-based split: train on weeks 1-156, validate on 157-182, test on 183-208. Never shuffle time series data."
        },
        {
          "step": 3,
          "action": "Baseline Model",
          "details": "SARIMA per top-10 SKUs as baseline. Use seasonal naive as floor benchmark."
        },
        {
          "step": 4,
          "action": "XGBoost Training",
          "details": "Global model across all SKUs. Use store-SKU ID as categorical feature. Optuna for hyperparameter tuning (500 trials, 5-fold time-series CV)."
        },
        {
          "step": 5,
          "action": "Evaluation",
          "details": "Compare MAPE, MAE, RMSE, and bias. Segment by SKU volume (A/B/C) — XGBoost typically wins on A items, SARIMA competitive on C items."
        },
        {
          "step": 6,
          "action": "Ensemble (Optional)",
          "details": "Stack XGBoost + Prophet for 1-3% MAPE improvement. Use Prophet for trend/seasonality residuals as XGBoost features."
        },
        {
          "step": 7,
          "action": "Production Deployment",
          "details": "Weekly retraining pipeline (Airflow/Prefect). Model registry (MLflow). A/B test against current forecasting method for 4 weeks."
        },
        {
          "step": 8,
          "action": "Monitoring",
          "details": "Track forecast accuracy decay over time. Alert if MAPE exceeds baseline by >2pp. Retrain trigger on concept drift detection."
        }
      ]
    },
    "comparison_matrix": {
      "best_accuracy": "XGBoost",
      "easiest_to_implement": "Prophet",
      "best_interpretability": "ARIMA",
      "best_at_scale": "XGBoost or LSTM",
      "best_for_prototyping": "Prophet"
    }
  },
  "runtime_seconds": 53,
  "tokens_used": 3600
}
```

## Notes

- Async mode: orchestrator fires the task and continues, gets notified on completion
- 4 models compared with MAPE ranges, complexity ratings, and detailed pros/cons
- 8-step implementation plan is directly actionable for a data science team
- All structured JSON — could feed directly into a model comparison dashboard or Jupyter notebook
- XGBoost recommendation aligns with industry consensus for tabular retail forecasting
