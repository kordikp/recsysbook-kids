---
id: ch3-pipeline-d-exp
type: spine
title: "Trace a Real YouTube Recommendation"
readingTime: 3
standalone: false
teaser: "Follow one recommendation from the moment you open the app to the moment it appears on screen."
voice: explorer
parent: null
diagram: diagram-two-tower
recallQ: "How does YouTube find 20 videos from 800 million in 0.2 seconds?"
recallA: "Staged pipeline! Quick rough filters narrow 800M to 500 candidates, then careful ranking picks the best 20."
status: accepted
---

Let's follow exactly what happens from the moment you tap the YouTube app to the moment recommendations appear on your home screen. This all happens in under one second.

## 0.0 seconds: You Open the App

You tap the YouTube icon. Your phone sends a request to YouTube's servers: "Hey, this user just opened the app. What should we show them?"

The servers know who you are. They pull up your profile instantly.

## 0.1 seconds: Your Profile Snapshot

The system grabs a quick summary of you:

- **Last 10 videos watched**: 6 were Minecraft, 2 were funny animals, 1 was a science experiment, 1 was a music video
- **Time of day**: It's 4pm on Saturday (you usually watch longer videos on weekends)
- **Recent searches**: "minecraft castle tutorial", "best redstone builds"
- **Subscriptions**: 3 Minecraft channels, 2 gaming channels, 1 science channel

## 0.2 seconds: FIND -- Cast the Net

The system fires off multiple searches at the same time:

- **Collaborative**: "Users with similar history watched these..." -- pulls 200 candidates
- **Content-based**: "Videos similar to your last 10..." -- pulls 150 candidates
- **Subscriptions**: "New uploads from channels you follow" -- pulls 30 candidates
- **Trending**: "Popular videos in your region" -- pulls 50 candidates
- **Exploration**: "Random promising videos you might discover" -- pulls 70 candidates

Total: roughly **500 candidates** gathered in a fraction of a second.

## 0.4 seconds: RANK -- Score Everything

Now each of those 500 videos gets a score. The system predicts:

| Video | Click Chance | Watch Time | Like Chance | Final Score |
|---|---|---|---|---|
| Minecraft mega build | 85% | 12 min | 70% | 0.94 |
| Funny cat compilation | 60% | 4 min | 50% | 0.71 |
| New redstone tutorial | 75% | 8 min | 65% | 0.82 |
| Science volcano experiment | 40% | 6 min | 45% | 0.55 |
| Trending pop music video | 30% | 3 min | 20% | 0.38 |
| ... | ... | ... | ... | ... |

The exact formula is secret, but it combines click probability, expected watch time, and likelihood of a positive reaction.

## 0.7 seconds: CHECK -- Final Touches

The top 30 videos by score go through final checks:

- 8 out of the top 10 are Minecraft? Swap some out for variety. Keep 4 Minecraft, add the cat video, the science video, a new gaming video, and a surprise.
- Already watched that redstone tutorial yesterday? Remove it.
- One video is 45 minutes long? Maybe save that for later. Show a mix of short and medium videos.
- Everything age-appropriate? Check.

## 0.9 seconds: DELIVER

The final 20 videos appear on your home screen. Thumbnails load. You see:

1. Minecraft mega castle build (top match)
2. New video from a subscribed channel
3. Funny cat compilation
4. Redstone tutorial (different from yesterday's)
5. Science experiment
6. ...and 15 more carefully chosen videos

You tap the first one without thinking twice. The system nailed it.

## The Mind-Blowing Part

This entire process -- from app open to recommendations displayed -- took less than one second. And it happened not just for you, but for the **2 billion other people** using YouTube at the same time.

That's the engineering behind the "simple" home screen you see every day. Not so simple after all.
