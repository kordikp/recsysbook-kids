---
id: ch3-bandits
type: spine
title: "The Explore-Exploit Dilemma"
readingTime: 3
standalone: true
core: true
teaser: "Should the algorithm show you something it KNOWS you'll like, or try something new? This is one of the hardest problems in recommendations."
voice: universal
parent: null
diagram: null
recallQ: "What is the explore-exploit dilemma?"
recallA: "Should the system show safe picks you'll like (exploit) or try new things you might discover (explore)? Both matter."
status: accepted
---

![The Explore-Exploit Restaurant](/images/comic-bandits.svg)

Imagine you're at a food court with 20 restaurants. You've tried 3 and loved one of them. Do you go back to your favorite (safe bet) or try a new place (might be amazing, might be terrible)?

This is called the **explore-exploit dilemma**, and every recommender system faces it constantly.

## Exploit: Play It Safe

**Exploiting** means recommending things the algorithm already knows you'll like. You watched 10 cooking videos? Here are 10 more cooking videos.

The problem: you get stuck. Maybe you'd LOVE science videos, but the algorithm never shows you one because it's too busy exploiting what it already knows.

## Explore: Take a Risk

**Exploring** means showing you something the algorithm isn't sure about. Maybe a travel vlog, a music documentary, a coding tutorial. Most of these won't stick — but one might open up a whole new interest.

## Bandit Algorithms: The Smart Balance

Computer scientists solved this with **bandit algorithms** (named after slot machines — "one-armed bandits" — in casinos).

The idea: start by exploring a lot. As you learn what works, gradually shift to exploiting. But never stop exploring completely.

**Thompson Sampling** — one popular approach — works like this:
1. For each item, keep track of how often it succeeded vs. failed
2. Randomly sample from those success rates
3. Show the item that got the highest random sample
4. This naturally balances: items with few data points get explored, proven items get exploited

## Contextual Bandits: Even Smarter

Real recommendations depend on **context**. You might want cooking videos on Sunday morning but gaming videos on Friday night.

**Contextual bandits** consider the situation:
- What time is it?
- What device are you using?
- What did you just watch?
- What's trending right now?

They learn: "For THIS user, in THIS context, THESE items tend to work." It's like having a friend who knows that you want comfort food when you're tired and adventure food when you're excited.

![Explore-Exploit Dilemma](/images/diagram-bandit-exploration.svg)

**Why this matters**: Without exploration, recommendations get boring and predictable. Without exploitation, they feel random and unhelpful. The best systems find the sweet spot — and bandit algorithms are how they do it.
