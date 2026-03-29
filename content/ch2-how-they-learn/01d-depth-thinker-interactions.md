---
id: ch2-interactions
type: spine
title: "Explicit vs. Implicit: Two Kinds of Feedback"
readingTime: 3
standalone: false
teaser: "Star ratings vs. watch time — why modern recommenders trust what you DO more than what you SAY."
voice: thinker
parent: null
diagram: null
recallQ: "Why do modern recommender systems prefer implicit feedback over explicit ratings?"
recallA: "Because users rarely rate things, ratings can be biased (mood, social pressure), and implicit signals like watch time, skips, and completions are collected automatically for every interaction."
status: accepted
---

When you give a movie 4 stars, that's you **telling** the system what you think. But when you binge-watch a series until 3 AM on a school night, that's the system **watching** what you actually do. These two types of information are called **explicit** and **implicit** feedback — and they're very different.

## Explicit Feedback: What You Say

Explicit feedback is anything where you **actively** tell the system your opinion:

- **Star ratings** (1 to 5 stars on Amazon)
- **Thumbs up / thumbs down** (YouTube, Netflix)
- **Written reviews** ("This book changed my life!")
- **Wishlists** (adding a game to your Steam wishlist)
- **Likes** (hearting a post on Instagram)

This seems like the best data, right? The user is literally telling you what they think. But there's a big catch...

## The Bias Problem

Ratings lie. Well, not on purpose — but they're messy:

- **Mood matters**: You might rate a movie higher on a Friday night than a Monday morning
- **Social pressure**: People rate popular movies higher because everyone says they're great
- **The missing data problem**: You only rate things you already chose to watch — you never rate the stuff you skipped, which might tell us even more
- **Rating fatigue**: After the 5th "Please rate this!" popup, most people just stop rating anything
- **Scale confusion**: Your "3 stars" might be someone else's "4 stars"

The biggest problem? **Most people don't rate things at all.** Netflix found that only about 1% of views resulted in a rating. That means 99% of useful information was invisible.

## Implicit Feedback: What You Do

Implicit feedback is everything the system can observe **without you doing anything special**:

- **Watch time**: Did you watch 10 seconds or the whole thing?
- **Completion rate**: Did you finish the video, article, or song?
- **Skip patterns**: Did you skip the intro? Fast-forward through parts?
- **Scroll speed**: Did you linger on a post or fly past it?
- **Repeat behavior**: Did you watch it again? Listen to that song on repeat?
- **Time of day**: Comedy at night, news in the morning?
- **Device**: Phone during commute, TV on the couch?
- **What you did next**: Did you search for similar content afterward?

None of this requires you to click a rating button. It just... happens.

## Why Implicit Wins

| | Explicit Feedback | Implicit Feedback |
|---|---|---|
| **Volume** | Rare (1% of interactions) | Every single interaction |
| **Effort** | User must actively rate | Collected automatically |
| **Bias** | Mood, social pressure, fatigue | Actions are harder to fake |
| **Coverage** | Only rated items | All items you interact with |
| **Negative signal** | "I rated this 1 star" | "I watched 5 seconds and left" |
| **Real-time** | Delayed (rate after watching) | Instant (measured while watching) |

The shift from explicit to implicit feedback changed everything:

- **Netflix** moved from a 5-star rating system to simple thumbs up/down in 2017 — because the simple version actually generated more useful data
- **YouTube** prioritizes **watch time** over likes — a video you watch for 20 minutes matters more than one you liked but only watched for 30 seconds
- **TikTok** is built almost entirely on implicit signals — completion rate, replays, shares, and how long you pause on a video before scrolling

## The Best of Both Worlds

Smart recommender systems don't throw away explicit feedback — they combine both. An explicit "thumbs down" is a very strong signal. But when you have to choose which to rely on more heavily, implicit feedback wins because of its sheer volume and honesty.

Think of it this way: if you asked someone "What's your favorite food?" they might say "salad" (sounds healthy, right?). But if you watched what they actually order every day, you'd get a very different — and more accurate — picture. That's the difference between explicit and implicit feedback.
