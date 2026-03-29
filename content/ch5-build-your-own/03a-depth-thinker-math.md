---
id: ch5-math-d-think
type: spine
title: "The Math Behind Similarity"
readingTime: 3
standalone: false
teaser: "How computers measure similarity using cosine similarity."
voice: thinker
parent: null
diagram: null
recallQ: "What does cosine similarity measure?"
recallA: "The angle between two preference vectors — so someone who rates everything low but in the same PATTERN as you is still similar."
status: accepted
---

The "average difference" method from the main chapter works fine for a small project. But real recommendation systems need something more precise. The most popular method is called **cosine similarity**, and it's more intuitive than it sounds.

**Think of it like a compass.**

Imagine each person's ratings as a direction on a compass. If Alex rates three movies [5, 4, 5], that's like pointing in one direction. If Sam rates the same movies [5, 5, 4], that's pointing in a very similar direction. If Jordan rates them [1, 2, 1], that's pointing almost the opposite way.

Cosine similarity measures the **angle** between two people's "directions." If they point the same way, the angle is small and the similarity is close to **1**. If they point in completely different directions, the similarity is close to **0**. If they're exactly opposite, it's **-1**.

**A simple example:**

Alex rates two movies: [5, 4]
Sam rates the same movies: [5, 5]

Picture these as arrows on a graph. Alex's arrow goes 5 units right and 4 units up. Sam's arrow goes 5 right and 5 up. They're pointing in almost the same direction!

The formula calculates the angle between these arrows. Without going into the full equation, here's what matters:

- Alex [5, 4] vs Sam [5, 5] = similarity of **0.98** (super similar!)
- Alex [5, 4] vs Jordan [1, 2] = similarity of **0.95** (hmm, also high?)

Wait -- that doesn't seem right. Jordan gave low ratings but the pattern is similar (both slightly favor the first movie). This is actually an important insight: cosine similarity measures the **pattern**, not the scale. Someone who rates everything low but in the same pattern as you is considered similar.

**Why this matters:**

Some people are "tough raters" who never give 5 stars. Others give 5 stars to everything they don't hate. Cosine similarity doesn't care about that difference -- it cares about whether you AGREE on which movies are better or worse than others.

**What computers actually do:**

Real systems try many different similarity measures and use A/B tests (from the last chapter!) to find which one works best for their data. Cosine similarity is the most common starting point, but it's not the only option.

![Matrix Factorization](/images/comic-mf.svg)

![Matrix Decomposition](/images/diagram-mf-decomposition.svg)

**The key idea:** Similarity is about finding people whose opinions move in the same direction as yours -- not people who use the same star ratings.
