---
id: ch5-formulas
type: spine
title: "The Math Behind Recommendations"
readingTime: 4
standalone: false
teaser: "Cosine similarity, matrix factorization, and nDCG — the formulas that power every recommender, explained so a 12-year-old gets it."
voice: thinker
parent: null
diagram: null
core: false
recallQ: "What does cosine similarity actually measure?"
recallA: "The angle between two vectors of preferences. If two people rate things in the same pattern (even at different scales), the angle is small and similarity is high."
status: accepted
---

Don't worry — you don't need to memorize these formulas. The goal is to **recognize** them when you see them, understand what they measure, and know why they matter. Think of it like reading a recipe: you don't need to cook it right now, but you should understand what the dish is.

## 1. Cosine Similarity — "Are we pointing the same direction?"

$$\text{sim}(A, B) = \frac{A \cdot B}{\|A\| \times \|B\|}$$

**What it means in plain English:**

- **A** and **B** are two people's ratings, written as lists of numbers (vectors)
- **A · B** (dot product) = multiply each pair of ratings together and add them up
- **||A||** = the "length" of A's vector (how far the arrow reaches)
- The result is a number between **-1** and **1**

**Example:** Alex rates [5, 4, 5] and Sam rates [4, 3, 4].

- A · B = 5×4 + 4×3 + 5×4 = 20 + 12 + 20 = **52**
- ||A|| = √(25 + 16 + 25) = √66 ≈ **8.12**
- ||B|| = √(16 + 9 + 16) = √41 ≈ **6.40**
- sim = 52 / (8.12 × 6.40) = 52 / 51.97 ≈ **1.00** (almost perfect match!)

**Why it matters:** Sam rates everything a bit lower, but in the SAME pattern. Cosine similarity catches this — it measures the direction, not the scale.

## 2. Matrix Factorization — "Find the hidden reasons"

$$R \approx U \times V^T$$

**What it means:**

- **R** = the big rating matrix (users × items, mostly empty)
- **U** = a smaller matrix of user preferences (each user = a short list of hidden factors)
- **V** = a smaller matrix of item qualities (each item = a short list of hidden factors)
- **≈** means "approximately equals" — we can't get it exactly right, but close enough

**The idea:** Every user and every item can be described by a few hidden numbers. Maybe factor 1 is "likes action movies," factor 2 is "prefers short content." The system discovers these factors automatically — nobody tells it what they mean!

**Example with 2 factors:**

- You = [0.9 action, 0.2 comedy]
- Movie A = [0.8 action, 0.1 comedy]
- Predicted rating = 0.9 × 0.8 + 0.2 × 0.1 = 0.72 + 0.02 = **0.74** → You'll probably like it!

**Why it matters:** This is how Netflix, Spotify, and YouTube compress millions of ratings into a small, useful model. It's like summarizing a 1000-page book into a 10-word description — you lose some detail but capture the essence.

## 3. nDCG — "How good is this ranked list?"

$$\text{DCG} = \sum_{i=1}^{k} \frac{\text{relevance}_i}{\log_2(i + 1)}$$

$$\text{nDCG} = \frac{\text{DCG}}{\text{ideal DCG}}$$

**What it means:**

- You have a list of recommended items, ranked from #1 to #k
- Each item has a **relevance score** (how good it is for the user — e.g., 0, 1, 2, or 3)
- Items higher in the list get a **bonus** (dividing by log makes position 1 worth much more than position 10)
- **nDCG** normalizes the score to be between 0 and 1 by comparing to the **perfect** ranking

**Example:** A system recommends [Great, OK, Bad, Great] in that order.

- DCG = 3/log₂(2) + 1/log₂(3) + 0/log₂(4) + 3/log₂(5) = 3 + 0.63 + 0 + 1.29 = **4.92**
- Perfect order would be [Great, Great, OK, Bad] = 3 + 1.89 + 0.5 + 0 = **5.39**
- nDCG = 4.92 / 5.39 = **0.91** (pretty good!)

**Why it matters:** nDCG answers the question every recommendation team asks: "How close is our ranking to perfect?" A score of 1.0 means perfect. Most real systems score 0.3-0.7 because the problem is genuinely hard.

## Putting It Together

| Formula | What it does | Where it's used |
|---------|-------------|----------------|
| Cosine similarity | Finds similar users/items | Collaborative filtering |
| Matrix factorization | Discovers hidden preferences | Training recommendation models |
| nDCG | Measures ranking quality | Evaluating if the system is good |

These three formulas are the foundation. Real systems add many more — but if you understand these, you understand the core math of recommendation systems.
