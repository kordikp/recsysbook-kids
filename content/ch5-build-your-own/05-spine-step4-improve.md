---
id: ch5-improve
type: spine
title: "Step 4: Make It Better"
readingTime: 3
standalone: true
core: true
teaser: "Your system works! Now let's make it smarter."
voice: universal
parent: null
diagram: null
---

You built a working recommendation system. That's amazing. But if you tested it, you probably noticed it's not perfect. Some predictions were spot on, others were way off.

Welcome to the life of a recommendation engineer. The system is never "done." There's always a way to make it better. Here are the tricks the pros use:

**1. Get more data**

The single biggest improvement? More ratings. If you surveyed 10 people, try 20. If you used 10 movies, try 20. More data means more connections to find, and better predictions. Netflix has over 200 million users rating thousands of movies -- that's why their recommendations are so accurate.

**2. Consider what TYPE of movie it is**

Right now, your system only looks at ratings. But what if you also knew each movie's genre? A person who loves Frozen and Moana clearly likes animated musical adventures. So you could boost predictions for OTHER animated musicals, even if you don't have enough rating data.

This is called **content-based filtering** -- using what you know about the ITEMS, not just the people.

**3. Give new releases a boost**

A brand-new movie that just came out might be amazing, but nobody has rated it yet. Your system would never recommend it! Smart systems give new content a temporary boost so it gets a chance to be discovered.

**4. Don't just recommend popular stuff**

If you always recommend the highest-rated movies, everyone gets the same recommendations. Boring! Try mixing in some less-popular movies that match the person's specific taste. Sometimes the best recommendation is a movie with 4 stars from 50 people, not 4.5 stars from 5 million people.

**5. Track what they DO, not just what they RATE**

In real life, most people don't rate things. But they DO watch, skip, pause, rewind, and share. A movie someone watched three times is clearly a favorite, even if they never gave it a star rating. Real systems use all these signals.

**6. Keep testing**

Remember A/B tests from the last chapter? Every change you make should be tested. Maybe adding genres helped predictions. Maybe it made them worse. You won't know until you test.

**The big picture:** You're now thinking like a recommendation engineer. You built a system, tested it, found problems, and brainstormed improvements. That's exactly the same process used at YouTube, Spotify, Netflix, and every other company that recommends things.

**Think about it!** Which improvement do you think would help YOUR system the most? Try it out! Change one thing, rerun your predictions, and see if the accuracy improves. That's science.
