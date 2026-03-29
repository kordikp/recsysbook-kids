---
id: ch4-objectives
type: spine
title: "What Is the Algorithm Actually Trying to Do?"
readingTime: 4
standalone: true
core: true
teaser: "Every recommender optimizes SOMETHING. The question is: whose goals does it serve?"
voice: universal
parent: null
diagram: diagram-objectives
recallQ: "What is the algorithm actually trying to do?"
recallA: "It depends! Subscription services optimize for YOUR happiness. Free/ad services optimize for ADVERTISER revenue."
status: accepted
---

Here's a secret most people don't know: every recommendation algorithm has a **goal** — a number it's trying to make as big (or small) as possible. This is called the **objective function**, and it determines EVERYTHING about what you see.

## Different Goals, Different Recommendations

Imagine the same movie app with three different objectives:

**Objective: Maximize Watch Time** — The algorithm shows you content that keeps you watching as long as possible. Sounds good? But it might push cliffhanger series and autoplay over movies you'd actually enjoy more.

**Objective: Maximize Purchases** — Now it pushes expensive new releases and rentals, even if there's a free movie you'd love. The algorithm is optimizing for the company's wallet, not your happiness.

**Objective: Maximize User Satisfaction** — This one tries to find what you'll genuinely enjoy. But "satisfaction" is hard to measure — the algorithm has to guess from your behavior.

## The Four Perspectives

According to researchers at [Recombee](https://www.recombee.com/blog/modern-recommender-systems-part-3-objectives), good recommender systems need to balance four perspectives:

| Perspective | Wants | Example |
|---|---|---|
| **User** | Relevant, surprising, trustworthy recs | "Show me things I'll actually like" |
| **Content creator** | Fair exposure, reaching the right audience | "Give my new video a chance!" |
| **Business** | Revenue, retention, growth | "Keep subscribers from canceling" |
| **Product** | Speed, fairness, compliance with laws | "Treat all users equally" |

## When Goals Clash

The dangerous part? These goals often **conflict**. A Spotify experiment found that personalized podcast recommendations increased streams by 29% — but reduced listening diversity by 11%. More engagement, less discovery.

Even worse: when a company optimizes purely for revenue (pushing high-margin products), users eventually notice and leave. Short-term profit kills long-term trust.

## The Free vs. Paid Question

Here's something to think about: **who is paying matters**.

- **Subscription services** (Netflix, Spotify Premium) — You're the customer. The algorithm mostly optimizes YOUR experience, because if you're unhappy, you cancel.

- **Free services** (YouTube, TikTok, Instagram) — You're not the customer. Advertisers are. The algorithm needs to keep you watching so it can show you ads. Your attention is the product being sold.

This doesn't mean free services are evil — but it means their recommendations have a different pressure. They need to balance keeping you happy AND keeping advertisers happy. Sometimes those goals align. Sometimes they don't.

**The key question to ask about any recommendation**: *What is this algorithm actually trying to maximize? And is that the same as what I want?*
