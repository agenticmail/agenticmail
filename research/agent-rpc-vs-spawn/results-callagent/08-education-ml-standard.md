---
test_name: ml-curriculum-4week
domain: Education
mode: standard (async)
runtime: ~93s
method: AgenticMail Call Agent
output_format: Structured JSON
---

# 4-Week Machine Learning Curriculum for Working Professionals

**Mode:** `standard` (async).

## Result

```json
{
  "status": "completed",
  "task_id": "ml-curriculum-4week",
  "mode": "standard",
  "async": true,
  "result": {
    "curriculum_name": "Applied Machine Learning Foundations",
    "target_audience": "Working professionals with programming experience (Python), basic statistics, and linear algebra fundamentals",
    "total_hours": 60,
    "format": "Self-paced with weekly live sessions (2h/week)",
    "prerequisites": {
      "required": [
        "Python proficiency (functions, classes, data structures)",
        "Basic statistics (mean, variance, distributions, hypothesis testing)",
        "Linear algebra fundamentals (vectors, matrices, dot products)",
        "Comfort with Jupyter notebooks"
      ],
      "recommended": [
        "Pandas/NumPy experience",
        "SQL basics",
        "Version control (Git)"
      ],
      "pre_assessment": "20-question diagnostic covering Python, statistics, and linear algebra. Must score ≥70% to proceed without remediation."
    },
    "weeks": [
      {
        "week": 1,
        "title": "Foundations & Supervised Learning",
        "hours": 15,
        "objectives": [
          "Understand the ML pipeline end-to-end",
          "Implement linear regression from scratch and with scikit-learn",
          "Perform exploratory data analysis (EDA)",
          "Apply train/test/validation splitting correctly"
        ],
        "topics": [
          "ML taxonomy (supervised, unsupervised, reinforcement)",
          "Feature engineering and selection",
          "Linear regression (OLS, gradient descent)",
          "Logistic regression and classification metrics",
          "Bias-variance tradeoff",
          "Cross-validation strategies"
        ],
        "project": {
          "title": "Housing Price Predictor",
          "description": "Build an end-to-end regression pipeline on the Ames Housing dataset. Include EDA, feature engineering, model training, and evaluation.",
          "deliverable": "Jupyter notebook + 5-min recorded walkthrough"
        },
        "resources": [
          "Hands-On ML Ch. 1-4 (Géron)",
          "StatQuest: Linear Regression (YouTube)",
          "scikit-learn documentation: Linear Models"
        ],
        "assessment": "Quiz (20%) + Project (80%)"
      },
      {
        "week": 2,
        "title": "Tree-Based Methods & Model Selection",
        "hours": 15,
        "objectives": [
          "Implement and tune decision trees, random forests, and gradient boosting",
          "Understand ensemble methods and why they work",
          "Master hyperparameter tuning with cross-validation",
          "Handle imbalanced datasets"
        ],
        "topics": [
          "Decision trees (CART algorithm, pruning)",
          "Random forests (bagging, feature importance)",
          "Gradient boosting (XGBoost, LightGBM)",
          "Hyperparameter tuning (GridSearch, RandomSearch, Optuna)",
          "Handling imbalanced data (SMOTE, class weights, threshold tuning)",
          "Model interpretability (SHAP, feature importance)"
        ],
        "project": {
          "title": "Customer Churn Classifier",
          "description": "Build a churn prediction model for a telecom dataset. Handle class imbalance, tune hyperparameters, and provide SHAP explanations for top predictions.",
          "deliverable": "Jupyter notebook + business-facing summary (1 page)"
        },
        "resources": [
          "Hands-On ML Ch. 6-7 (Géron)",
          "XGBoost documentation",
          "SHAP library documentation"
        ],
        "assessment": "Quiz (20%) + Project (80%)"
      },
      {
        "week": 3,
        "title": "Unsupervised Learning & Deep Learning Intro",
        "hours": 15,
        "objectives": [
          "Apply clustering and dimensionality reduction techniques",
          "Build and train neural networks with PyTorch/Keras",
          "Understand backpropagation intuitively",
          "Know when deep learning adds value over traditional ML"
        ],
        "topics": [
          "K-Means, DBSCAN, hierarchical clustering",
          "PCA, t-SNE, UMAP for visualization",
          "Neural network fundamentals (perceptron, activation functions)",
          "Backpropagation and gradient descent variants (Adam, SGD)",
          "Feedforward networks for tabular data",
          "CNNs overview (image classification)",
          "Transfer learning concept"
        ],
        "project": {
          "title": "Customer Segmentation + Image Classifier",
          "description": "Part A: Segment e-commerce customers using clustering + PCA visualization. Part B: Fine-tune a pretrained ResNet for product image classification (10 categories).",
          "deliverable": "Two notebooks + combined presentation (10 slides)"
        },
        "resources": [
          "Hands-On ML Ch. 8-10, 14 (Géron)",
          "3Blue1Brown: Neural Networks (YouTube)",
          "PyTorch tutorials (pytorch.org)"
        ],
        "assessment": "Quiz (20%) + Project (80%)"
      },
      {
        "week": 4,
        "title": "NLP, MLOps & Capstone",
        "hours": 15,
        "objectives": [
          "Apply NLP techniques from TF-IDF to transformers",
          "Build a production ML pipeline",
          "Deploy a model as a REST API",
          "Complete a capstone project demonstrating end-to-end ML"
        ],
        "topics": [
          "Text preprocessing (tokenization, stemming, TF-IDF)",
          "Word embeddings (Word2Vec, GloVe)",
          "Transformers and Hugging Face (BERT, fine-tuning)",
          "Sentiment analysis pipeline",
          "MLOps: experiment tracking (MLflow), model versioning",
          "Model deployment (FastAPI, Docker)",
          "Monitoring and drift detection"
        ],
        "project": {
          "title": "Capstone: End-to-End ML Product",
          "description": "Choose a domain problem, build a complete ML pipeline (data → training → evaluation → deployment). Must include: data versioning, experiment tracking, REST API, and a 1-page model card.",
          "deliverable": "GitHub repo + deployed API endpoint + 10-min presentation"
        },
        "resources": [
          "Hugging Face Course (free)",
          "MLflow documentation",
          "FastAPI tutorial (tiangolo)"
        ],
        "assessment": "Capstone (100%) — evaluated on code quality, model performance, deployment, and presentation"
      }
    ],
    "grading": {
      "weekly_quizzes": "10% (4 quizzes × 2.5%)",
      "weekly_projects": "60% (3 projects × 20%)",
      "capstone": "30%",
      "passing_grade": "70%",
      "distinction": "90%"
    },
    "post_curriculum_paths": [
      {
        "path": "MLOps Engineer",
        "next_steps": "Kubernetes, CI/CD for ML, cloud platforms (AWS SageMaker, GCP Vertex AI)"
      },
      {
        "path": "Deep Learning Specialist",
        "next_steps": "Advanced architectures (transformers, GANs, diffusion models), distributed training"
      },
      {
        "path": "Data Science Lead",
        "next_steps": "A/B testing, causal inference, stakeholder communication, team management"
      },
      {
        "path": "AI Product Manager",
        "next_steps": "ML product design, responsible AI, cost-benefit analysis, user research"
      }
    ],
    "tools_used": [
      "Python 3.10+",
      "scikit-learn",
      "XGBoost / LightGBM",
      "PyTorch or Keras",
      "Hugging Face Transformers",
      "MLflow",
      "FastAPI",
      "Docker",
      "Jupyter / VS Code"
    ]
  },
  "runtime_seconds": 93,
  "tokens_used": 4400
}
```

## Notes

- Complete 4-week curriculum with 60 total hours, prerequisites, projects, resources, and assessments
- Each week has clear objectives, topics, a hands-on project, and evaluation criteria
- Post-curriculum career paths provide progression guidance
- All structured JSON — could feed into an LMS (Learning Management System) or course builder
- Async mode allowed orchestrator to continue with other tasks while this completed
