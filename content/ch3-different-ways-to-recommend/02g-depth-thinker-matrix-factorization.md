---
id: ch3-matrix-factorization
type: spine
title: "Matrix Factorization: The Netflix Method"
readingTime: 4
standalone: false
teaser: "How Netflix compressed millions of ratings into hidden taste dimensions — and why this technique won the million-dollar prize."
voice: thinker
parent: null
diagram: diagram-mf-decomposition
recallQ: "What does matrix factorization do to a giant ratings matrix?"
recallA: "It breaks it into two smaller matrices — one for users and one for items — each containing hidden taste dimensions. Multiplying them back approximates the original, filling in the blanks."
status: accepted
---

![Matrix Factorization Story](/images/comic-mf.svg)

Imagine you run a movie streaming service with 100 million users and 500,000 movies. If you wrote every user's rating for every movie in a giant spreadsheet, that's **50 trillion cells**. And here's the kicker: about 99% of those cells are empty. Nobody has time to rate half a million movies.

So how do you predict what someone would rate a movie they've never seen?

## The Big Idea: Hidden Taste Dimensions

**Matrix factorization** says: forget the giant spreadsheet. Instead, describe every user and every item with a short list of hidden numbers — maybe 50 or 100 of them. These hidden numbers are called **latent factors**, and they capture things like:

- "How much does this person like action movies?"
- "How dark or lighthearted does this person prefer?"
- "Does this item have a strong visual style?"

Nobody tells the system what these factors mean. It discovers them on its own by looking at patterns in the ratings. Pretty wild, right?

## How It Works

Mathematically, we take the giant ratings matrix **R** (users on one side, items on the other) and break it into two smaller matrices:

$$R \approx U \times V^T$$

- **U** is the user matrix — each user becomes a short vector (list of numbers)
- **V** is the item matrix — each item becomes a short vector of the same length
- **Multiply them back together** and you get an approximation of R — but now the empty cells are filled in with predictions!

**Example with 2 hidden factors:**

Say the two hidden factors happen to capture "action-lover" and "comedy-lover" (the system figured this out, nobody told it).

- You = [0.9 action, 0.2 comedy]
- Movie A (Die Hard) = [0.8 action, 0.1 comedy]
- Predicted rating = 0.9 $\times$ 0.8 + 0.2 $\times$ 0.1 = 0.72 + 0.02 = **0.74** out of 1 — you'll probably like it!
- Movie B (The Hangover) = [0.1 action, 0.9 comedy]
- Predicted rating = 0.9 $\times$ 0.1 + 0.2 $\times$ 0.9 = 0.09 + 0.18 = **0.27** — not your thing.

## Learning the Numbers: ALS

But how does the system figure out those hidden numbers? It uses an algorithm called **ALS** — Alternating Least Squares. Here's the trick:

1. **Start with random numbers** for all user and item vectors
2. **Fix the item vectors** and find the best user vectors (this is a straightforward math problem when one side is fixed!)
3. **Fix the user vectors** and find the best item vectors
4. **Alternate** — keep flipping back and forth until the predictions stop improving

The actual formula for updating a single user's vector looks like this:

$$u_i = (V^T V + \lambda I)^{-1} V^T r_i$$

Don't panic! Here's what each piece means:

- $u_i$ = the hidden taste vector we're trying to find for user i
- $V$ = all the item vectors (which we're holding fixed for now)
- $r_i$ = user i's actual ratings
- $\lambda I$ = a small safety cushion (more on this in a moment)

The formula basically says: "Given what we know about the items ($V$) and this user's ratings ($r_i$), what's the best set of hidden taste numbers for this user?"

## Why $\lambda$ Matters (Regularization)

That $\lambda$ (lambda) in the formula is called **regularization**, and it's super important. Without it, the system might go crazy trying to perfectly match every single rating — including the weird ones where someone accidentally hit 1 star instead of 5.

Regularization says: "Keep the numbers reasonable. Don't overfit." It's like a teacher saying "Give me the general idea, not a word-for-word copy." A small $\lambda$ lets the model be more precise; a large $\lambda$ keeps it more cautious. Finding the right balance is part of the art of building recommender systems.

## The Netflix Prize Connection

In 2006, Netflix offered **$1,000,000** to anyone who could beat their recommendation algorithm by 10%. Thousands of teams competed for three years. The winning approach? You guessed it — a sophisticated version of matrix factorization.

The BellKor team showed that by combining matrix factorization with other techniques, you could dramatically improve prediction accuracy. This competition put matrix factorization on the map and changed how the entire industry thinks about recommendations.

## Why This Still Matters

Even though deep learning has taken over many areas of AI, matrix factorization is still used everywhere because:

- It's **fast** — you can run it on huge datasets
- It's **interpretable** — each factor captures something meaningful
- It's **proven** — decades of research and real-world use
- It's the **foundation** — many modern approaches are extensions of this idea

When you hear about "embeddings" in modern recommender systems, they're essentially the descendants of matrix factorization. The idea of representing users and items as short vectors in a shared space? That started right here.
