---
test: test-education
label: Education
domain: Education
runtime: 70s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---

# 4-Week Machine Learning Curriculum for Working Professionals

**Prerequisites:** Python proficiency (functions, classes, data structures, pip/virtual environments), basic statistics (mean, median, standard deviation), comfort with the command line.

**Time Commitment:** 10-12 hours/week

---

## Week 1: Foundations — Data, Math Intuition & Your First Model

**Learning Objectives:**
- Understand what ML is (and isn't) — supervised vs. unsupervised vs. reinforcement learning
- Build fluency with NumPy, Pandas, and Matplotlib for data manipulation and visualization
- Grasp the core math intuition: linear algebra basics (vectors, matrices, dot products), probability, and gradient descent (conceptual, not proofs)
- Train and evaluate your first model using scikit-learn

**Topics Covered:**
1. ML taxonomy: classification, regression, clustering
2. The ML workflow: data → features → train → evaluate → iterate
3. Pandas for loading, cleaning, and exploring tabular data
4. NumPy for vectorized operations
5. Matplotlib/Seaborn for exploratory data analysis (EDA)
6. Linear regression and logistic regression from scratch (conceptual) and with scikit-learn
7. Train/test splits and why they matter

**Hands-On Project:** *Housing Price Predictor*
- Use the California Housing dataset (built into scikit-learn)
- Perform EDA: distributions, correlations, missing values
- Build a linear regression model, evaluate with RMSE and R²
- Visualize predictions vs. actuals
- Deliverable: Jupyter notebook with narrative explaining each step

**Recommended Resources (Free):**
- [Google's ML Crash Course — Framing & Descending into ML](https://developers.google.com/machine-learning/crash-course) (first 3 modules)
- [Kaggle Learn: Intro to Machine Learning](https://www.kaggle.com/learn/intro-to-machine-learning) (micro-course, ~4 hrs)
- [3Blue1Brown — Essence of Linear Algebra](https://www.youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab) (watch first 4 videos)
- [Python Data Science Handbook — Chapter 2-4](https://jakevdp.github.io/PythonDataScienceHandbook/) (free online)

**Estimated Hours:** 10-12 hrs (4 hrs resources, 3 hrs project, 3-5 hrs practice/exploration)

**Assessment Criteria:**
- [ ] Can explain supervised vs. unsupervised learning with examples
- [ ] Notebook runs end-to-end without errors
- [ ] EDA includes at least 3 meaningful visualizations with written observations
- [ ] Model achieves reasonable RMSE (below naive baseline of predicting the mean)
- [ ] Can explain what gradient descent does in plain English

---

## Week 2: Core Algorithms, Feature Engineering & Evaluation

**Learning Objectives:**
- Understand and apply 4-5 core ML algorithms beyond linear models
- Perform feature engineering: encoding, scaling, handling missing data, creating new features
- Master evaluation metrics and cross-validation
- Recognize and address overfitting vs. underfitting

**Topics Covered:**
1. Decision trees and random forests — how they work, why ensembles win
2. K-Nearest Neighbors (KNN)
3. Support Vector Machines (SVM) — intuition only
4. Feature engineering: one-hot encoding, label encoding, StandardScaler, MinMaxScaler
5. Handling missing data: imputation strategies
6. Cross-validation (k-fold) and why a single train/test split isn't enough
7. Metrics deep dive: accuracy, precision, recall, F1, confusion matrix, ROC-AUC
8. Bias-variance tradeoff, regularization (L1/L2 intuition)
9. Hyperparameter tuning with GridSearchCV

**Hands-On Project:** *Customer Churn Classifier*
- Use the Telco Customer Churn dataset (Kaggle)
- Handle mixed data types (numerical + categorical)
- Engineer at least 2 new features from existing columns
- Compare 3+ algorithms using cross-validation
- Tune the best model's hyperparameters
- Produce a classification report and ROC curve
- Deliverable: Notebook with model comparison table and written analysis of which model wins and why

**Recommended Resources (Free):**
- [Kaggle Learn: Intermediate Machine Learning](https://www.kaggle.com/learn/intermediate-machine-learning) (~4 hrs)
- [StatQuest: Random Forests](https://www.youtube.com/watch?v=J4Wdy0Wc_xQ) and [Cross Validation](https://www.youtube.com/watch?v=fSytzGwwBVw)
- [scikit-learn User Guide — Model Selection](https://scikit-learn.org/stable/model_selection.html)
- [Google ML Crash Course — Classification & Regularization modules](https://developers.google.com/machine-learning/crash-course)

**Estimated Hours:** 10-12 hrs (4 hrs resources, 4 hrs project, 2-4 hrs practice)

**Assessment Criteria:**
- [ ] Can explain how a random forest improves on a single decision tree
- [ ] Feature engineering is justified with reasoning (not arbitrary)
- [ ] Cross-validation used correctly (no data leakage)
- [ ] Model comparison includes at least 3 algorithms with multiple metrics
- [ ] Can explain precision vs. recall tradeoff in the context of churn
- [ ] Hyperparameter tuning shows measurable improvement

---

## Week 3: Neural Networks, Deep Learning Basics & NLP/Vision Taste

**Learning Objectives:**
- Understand how neural networks learn (forward pass, backpropagation, activation functions)
- Build and train a neural network using TensorFlow/Keras
- Get exposure to two major ML domains: NLP (text) and computer vision (images)
- Understand when deep learning is worth the complexity vs. classical ML

**Topics Covered:**
1. Perceptrons → multi-layer networks → deep learning
2. Activation functions: ReLU, sigmoid, softmax — when and why
3. Loss functions: MSE, cross-entropy
4. Optimizers: SGD, Adam (conceptual)
5. TensorFlow/Keras Sequential API: layers, compile, fit, evaluate
6. Overfitting in neural nets: dropout, early stopping, batch normalization
7. Convolutional Neural Networks (CNNs) — intuition for image tasks
8. NLP basics: tokenization, word embeddings, sentiment analysis with pre-trained models
9. Transfer learning concept: why you almost never train from scratch

**Hands-On Project:** *Handwritten Digit Classifier + Sentiment Analyzer*
- **Part A:** Build a CNN with Keras on the MNIST dataset. Achieve >97% accuracy. Visualize misclassified examples and hypothesize why.
- **Part B:** Use a pre-trained model (Hugging Face `pipeline`) to classify sentiment on 50+ product reviews you collect or source from a free dataset.
- Deliverable: Two notebooks. Part A shows architecture decisions and training curves. Part B compares pre-trained model results against a simple scikit-learn TF-IDF + Logistic Regression baseline.

**Recommended Resources (Free):**
- [3Blue1Brown — Neural Networks](https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi) (4 videos, essential)
- [TensorFlow/Keras Official Tutorials — Basic Classification](https://www.tensorflow.org/tutorials/keras/classification)
- [Hugging Face NLP Course — Chapter 1](https://huggingface.co/learn/nlp-course/chapter1) (free)
- [fast.ai Practical Deep Learning — Lesson 1](https://course.fast.ai/) (watch for intuition)

**Estimated Hours:** 11-13 hrs (5 hrs resources, 4 hrs project, 2-4 hrs experimentation)

**Assessment Criteria:**
- [ ] Can draw and explain a 3-layer neural network architecture
- [ ] MNIST model achieves >97% test accuracy
- [ ] Training curves (loss + accuracy) plotted for both train and validation sets
- [ ] Can articulate when to use deep learning vs. classical ML (with examples)
- [ ] Sentiment analysis includes comparison between pre-trained and baseline approaches
- [ ] Dropout or early stopping used and justified

---

## Week 4: End-to-End ML Pipeline & Model Deployment

**Learning Objectives:**
- Build a complete ML pipeline from raw data to deployed API
- Structure ML code for production (not just notebooks)
- Deploy a model as a web service that accepts requests and returns predictions
- Understand MLOps basics: versioning, monitoring, iteration

**Topics Covered:**
1. scikit-learn Pipelines: chaining preprocessing + model into one object
2. Saving/loading models: `joblib`, Keras `.save()`
3. Structuring ML projects: `src/`, `data/`, `models/`, `notebooks/` convention
4. Building a REST API with FastAPI to serve predictions
5. Containerization basics with Docker (Dockerfile for ML app)
6. Deployment options: Hugging Face Spaces (free), Railway, Render
7. MLOps awareness: experiment tracking (MLflow/Weights & Biases free tiers), data versioning, model monitoring concepts
8. Ethics and bias: fairness metrics, dataset bias, responsible ML checklist

**Hands-On Project:** *Deployed Loan Approval Predictor*
- Use a lending dataset (Kaggle Lending Club subset or similar)
- Build a full scikit-learn Pipeline (imputation → encoding → scaling → model)
- Export the trained pipeline with joblib
- Create a FastAPI app with a `/predict` endpoint that accepts applicant data as JSON and returns approval probability
- Write basic input validation
- Deploy to Hugging Face Spaces (free) as a Gradio or FastAPI app
- Write a README documenting: problem statement, data, model choice, how to run locally, API usage
- Deliverable: GitHub repo with clean code, deployed URL, and README

**Recommended Resources (Free):**
- [FastAPI Official Tutorial](https://fastapi.tiangolo.com/tutorial/) (first 3 sections)
- [Hugging Face Spaces Getting Started](https://huggingface.co/docs/hub/spaces-overview)
- [Made With ML — MLOps Course](https://madewithml.com/) (skim the deployment & testing sections)
- [Google's Responsible AI Practices](https://ai.google/responsibility/responsible-ai-practices/)
- [Full Stack Deep Learning — Deployment Lecture](https://fullstackdeeplearning.com/) (free recordings)

**Estimated Hours:** 12-14 hrs (3 hrs resources, 6 hrs project/deployment, 3-5 hrs debugging and polish)

**Assessment Criteria:**
- [ ] Pipeline handles raw input end-to-end (no manual preprocessing needed at inference)
- [ ] API returns valid JSON predictions for well-formed requests and clear errors for bad input
- [ ] Model is deployed and accessible via a public URL
- [ ] GitHub repo has a clear README with setup instructions and API documentation
- [ ] Can explain the full journey from raw data → deployed prediction
- [ ] Addressed at least one fairness/bias consideration in the README (e.g., "income as a proxy for race")

---

## Curriculum Summary

| Week | Theme | Key Deliverable | Hours |
|------|-------|----------------|-------|
| 1 | Foundations & First Model | Housing price predictor notebook | 10-12 |
| 2 | Algorithms & Evaluation | Churn classifier with model comparison | 10-12 |
| 3 | Deep Learning & Domains | MNIST CNN + sentiment analyzer | 11-13 |
| 4 | Pipeline & Deployment | Deployed loan predictor API | 12-14 |
| **Total** | | | **43-51** |

## Tips for Working Professionals

1. **Block 2-hour sessions** — ML concepts need focused time, not 15-minute fragments
2. **Code along, don't just watch** — Pause videos, type the code, break it, fix it
3. **Use lunch breaks for videos** — Save coding sessions for evenings/weekends
4. **Keep a "confusion log"** — Write down what doesn't make sense. Revisit it 3 days later; half will click
5. **Join a community** — [r/learnmachinelearning](https://reddit.com/r/learnmachinelearning), Kaggle discussions, or find an accountability partner

## What Comes Next (Post-Curriculum)

After completing this curriculum, natural next steps based on interest:
- **Tabular/Business data:** XGBoost/LightGBM deep dive, feature stores, A/B testing
- **NLP:** Hugging Face Transformers course, fine-tuning LLMs, RAG systems
- **Computer Vision:** Transfer learning with ResNet/EfficientNet, object detection
- **MLOps:** MLflow, DVC, CI/CD for ML, monitoring drift
- **Kaggle competitions:** Best way to sharpen skills against real benchmarks